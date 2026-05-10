# -*- coding: utf-8 -*-
r"""
chiral_deep_probe.py — comprehensive single-shot diagnostic for the
relink-import access violation that survived dev49..dev64 on at least
one tester's machine. Runs every probe we'd want at once, spawns
child Python processes to attempt the actual fusionscript import
under each discoverable Python interpreter, and writes one big log
to the user's Desktop. The output makes the cause obvious — or
definitively rules out everything we can think of from our side.

HOW TO RUN (Windows, x64)

    Step 1. Make sure DaVinci Resolve is OPEN and a project is loaded.
    Step 2. Open PowerShell or Command Prompt.
    Step 3. Run with the Python embeddable bundled inside Chiral:

        "C:\path\to\Chiral-Network-0.5.0-devXX-x64\resources\vendor\python313\python.exe" `
            "C:\path\to\chiral_deep_probe.py"

       Or, if you have Python on PATH:

        python chiral_deep_probe.py

    Step 4. After ~15 seconds the probe writes its log to your Desktop:
                chiral_deep_probe_YYYYMMDD_HHMMSS.log
            Send that file back.

The probe DOES NOT MODIFY anything. No registry writes, no file
writes outside the log + a few temp files for child probes. It only
reads. Safe to run on any machine.

WHAT IT CHECKS — short list

    1.  System: OS version, architecture, Windows build
    2.  Environment variables (RESOLVE_SCRIPT_*, PATH, PYTHONPATH, …)
    3.  fusionscript.dll itself: size, mtime, SHA-256, full PE import
        table, embedded VS_FIXEDFILEINFO version, all `pythonXX.dll`
        string references
    4.  Resolve.exe version + SHA-256 (so we can fingerprint the
        Resolve build)
    5.  Every DLL in the Resolve install directory — names, sizes,
        versions (catches stripped / mismatched bundled CRTs)
    6.  Every modern VC++ runtime DLL in System32 — version, SHA-256
    7.  Python registry entries (HKLM + HKCU PythonCore\X.Y\InstallPath)
        — Resolve scripting consults this to find Python on Windows
    8.  Discoverable Python interpreters: bundled embeddables, py
        launcher list, system python.exe on PATH
    9.  ★ MULTI-PYTHON IMPORT TEST: for each Python found, spawn a
        child process that pre-loads System32 CRTs, enables
        faulthandler, and attempts `import DaVinciResolveScript`.
        Records exit code + faulthandler dump (if any) for each
       attempt. This is the most diagnostic single check.
    10. Resolve scripting preference (Local / Network / None) read
        from the Resolve config file
    11. Currently running processes that might inject DLLs (Resolve,
        AV products, shell extensions)
"""

import os
import sys
import re
import json
import time
import struct
import ctypes
import ctypes.wintypes as wt
import hashlib
import platform
import subprocess
import tempfile
import traceback


# ============================================================================
# Output bookkeeping
# ============================================================================

DESKTOP = os.path.join(
    os.environ.get('USERPROFILE') or os.path.expanduser('~'),
    'Desktop')
TS = time.strftime('%Y%m%d_%H%M%S')
LOG_PATH = os.path.join(DESKTOP, 'chiral_deep_probe_' + TS + '.log')
LOG_LINES = []

def log(msg=''):
    line = msg if isinstance(msg, str) else str(msg)
    LOG_LINES.append(line)
    try:
        print(line)
        sys.stdout.flush()
    except Exception:
        pass

def section(title):
    log()
    log('=' * 78)
    log('  ' + title)
    log('=' * 78)

def safe(label, fn, *args, **kwargs):
    """Run fn(*args, **kwargs); on any exception, log and return None.

    Each top-level probe is wrapped in this so a failure in one section
    can't kill the whole report."""
    try:
        return fn(*args, **kwargs)
    except Exception as e:
        log('  [{}] FAILED: {}: {}'.format(
            label, type(e).__name__, str(e)[:300]))
        log('    ' + traceback.format_exc().replace('\n', '\n    '))
        return None


# ============================================================================
# Helpers
# ============================================================================

def file_sha256(path):
    """Stream-hash a file. Bounded by IO speed; safe for large DLLs."""
    h = hashlib.sha256()
    try:
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 16), b''):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def file_version_string(path):
    """Read VS_FIXEDFILEINFO via VerQueryValueW. Returns 'a.b.c.d' or None."""
    try:
        version = ctypes.WinDLL('version', use_last_error=True)
        version.GetFileVersionInfoSizeW.argtypes = [
            wt.LPCWSTR, ctypes.POINTER(wt.DWORD)]
        version.GetFileVersionInfoSizeW.restype = wt.DWORD
        dummy = wt.DWORD(0)
        size = version.GetFileVersionInfoSizeW(path, ctypes.byref(dummy))
        if not size:
            return None
        buf = ctypes.create_string_buffer(size)
        version.GetFileVersionInfoW.argtypes = [
            wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.c_void_p]
        version.GetFileVersionInfoW.restype = wt.BOOL
        if not version.GetFileVersionInfoW(path, 0, size, buf):
            return None
        version.VerQueryValueW.argtypes = [
            ctypes.c_void_p, wt.LPCWSTR,
            ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wt.UINT)]
        version.VerQueryValueW.restype = wt.BOOL
        ptr = ctypes.c_void_p(0)
        plen = wt.UINT(0)
        if not version.VerQueryValueW(buf, "\\",
                                       ctypes.byref(ptr), ctypes.byref(plen)):
            return None
        ffi = ctypes.string_at(ptr.value, 16)
        ms_hi, ms_lo = struct.unpack('<HH', ffi[8:12])
        ls_hi, ls_lo = struct.unpack('<HH', ffi[12:16])
        return "{}.{}.{}.{}".format(ms_lo, ms_hi, ls_lo, ls_hi)
    except Exception:
        return None


def parse_pe_imports(path):
    """Hand-rolled PE import table walker. Returns list of imported DLL
    names (lowercased bytes) or raises. See chiral_diag.py for the
    full design rationale."""
    with open(path, 'rb') as f:
        data = f.read()
    if data[:2] != b'MZ':
        raise ValueError("not a PE file")
    e_lfanew = struct.unpack_from('<I', data, 0x3c)[0]
    if data[e_lfanew:e_lfanew + 4] != b'PE\x00\x00':
        raise ValueError("missing PE signature")
    fh = e_lfanew + 4
    machine, num_sections, _ts, _sp, _sn, opt_size, _chars = \
        struct.unpack_from('<HHIIIHH', data, fh)
    opt = fh + 20
    magic = struct.unpack_from('<H', data, opt)[0]
    if magic == 0x20b:    data_dir = opt + 112
    elif magic == 0x10b:  data_dir = opt + 96
    else: raise ValueError("bad opt magic 0x{:x}".format(magic))
    imp_rva, _ = struct.unpack_from('<II', data, data_dir + 8)
    if imp_rva == 0: return []
    sect = opt + opt_size
    sections = []
    for i in range(num_sections):
        s = sect + i * 40
        vs = struct.unpack_from('<I', data, s + 8)[0]
        va = struct.unpack_from('<I', data, s + 12)[0]
        rs = struct.unpack_from('<I', data, s + 16)[0]
        ro = struct.unpack_from('<I', data, s + 20)[0]
        sections.append((va, va + max(vs, rs), ro))
    def r2f(rva):
        for lo, hi, ro in sections:
            if lo <= rva < hi:
                return ro + (rva - lo)
        return None
    imp_off = r2f(imp_rva)
    if imp_off is None: raise ValueError("import RVA unmapped")
    out = []
    i = 0
    while True:
        ent = imp_off + i * 20
        if ent + 20 > len(data): break
        ilt, _, _, name_rva, _ = struct.unpack_from('<IIIII', data, ent)
        if ilt == 0 and name_rva == 0: break
        if name_rva:
            no = r2f(name_rva)
            if no is not None:
                end = data.find(b'\x00', no)
                if end < 0: end = no + 256
                out.append(data[no:end].lower())
        i += 1
        if i > 1024: break
    return out


def scan_dll_strings(path, max_bytes=8 * 1024 * 1024):
    with open(path, 'rb') as f:
        head = f.read(max_bytes)
    return sorted(set(re.findall(
        rb'[A-Za-z0-9_\-\.]+\.dll', head, re.IGNORECASE)))


# ============================================================================
# Section probes
# ============================================================================

def probe_environment():
    section('1. SYSTEM ENVIRONMENT')
    log('timestamp: ' + time.strftime('%Y-%m-%d %H:%M:%S'))
    log('platform:  ' + platform.platform())
    if sys.platform == 'win32':
        log('win_ver:   ' + str(sys.getwindowsversion()))
    log('machine:   ' + platform.machine())
    log('arch:      ' + ' / '.join(platform.architecture()))
    log('user:      ' + (os.environ.get('USERNAME') or '?'))
    log('driver Py: ' + sys.executable)
    log('driver ver:' + sys.version.replace('\n', ' '))
    log('cwd:       ' + os.getcwd())


def probe_env_vars():
    section('2. ENVIRONMENT VARIABLES')
    keys = ['RESOLVE_SCRIPT_API', 'RESOLVE_SCRIPT_LIB', 'PYTHONPATH',
            'PYTHONHOME', 'SYSTEMROOT', 'PROGRAMFILES', 'PROGRAMDATA',
            'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP',
            'PROCESSOR_ARCHITECTURE']
    for k in keys:
        log('  ' + k + ': ' + (os.environ.get(k) or '(unset)'))
    p = os.environ.get('PATH', '')
    log('  PATH ({} chars):'.format(len(p)))
    for d in p.split(os.pathsep):
        log('    ' + d)


def probe_fusionscript():
    section('3. FUSIONSCRIPT.DLL')
    candidates = []
    env_lib = os.environ.get('RESOLVE_SCRIPT_LIB')
    if env_lib:
        candidates.append(('env', env_lib))
    candidates.append((
        'default Program Files',
        r'C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll'))
    candidates.append((
        'ProgramData',
        r'C:\ProgramData\Blackmagic Design\DaVinci Resolve\fusionscript.dll'))

    found = []
    for label, p in candidates:
        log('')
        log('[' + label + '] ' + p)
        if not os.path.isfile(p):
            log('  NOT FOUND')
            continue
        found.append(p)
        st = os.stat(p)
        log('  size:    {} bytes'.format(st.st_size))
        log('  mtime:   ' + time.strftime('%Y-%m-%d %H:%M:%S',
                                          time.localtime(st.st_mtime)))
        log('  sha256:  ' + (file_sha256(p) or '?'))
        log('  Version: ' + (file_version_string(p) or '?'))

        # PE import table — high signal.
        try:
            imps = parse_pe_imports(p)
            log('  PE imports ({}):'.format(len(imps)))
            for nm in imps:
                log('    ' + nm.decode('latin-1'))
        except Exception as e:
            log('  PE parse failed: ' + str(e))

        # String scan — catches python*.dll referenced via runtime
        # LoadLibrary instead of static imports.
        try:
            strs = scan_dll_strings(p)
            python_strs = [s for s in strs
                          if re.match(rb'python\d', s, re.IGNORECASE)]
            log('  python*.dll string refs: ' +
                ', '.join(s.decode('latin-1') for s in python_strs))
        except Exception as e:
            log('  string scan failed: ' + str(e))

    return found


def probe_resolve_exe():
    section('4. RESOLVE.EXE METADATA')
    candidates = [
        r'C:\Program Files\Blackmagic Design\DaVinci Resolve\Resolve.exe',
    ]
    for p in candidates:
        log('[' + p + ']')
        if not os.path.isfile(p):
            log('  NOT FOUND'); continue
        st = os.stat(p)
        log('  size:    {} bytes'.format(st.st_size))
        log('  mtime:   ' + time.strftime('%Y-%m-%d %H:%M:%S',
                                          time.localtime(st.st_mtime)))
        log('  Version: ' + (file_version_string(p) or '?'))


def probe_resolve_dir_dlls():
    section('5. RESOLVE INSTALL DIRECTORY — every DLL with version + size')
    rdir = r'C:\Program Files\Blackmagic Design\DaVinci Resolve'
    if not os.path.isdir(rdir):
        log('  Resolve install dir not found.')
        return
    interesting_substrs = [
        'fusion', 'python', 'vcruntime', 'msvcp', 'msvcr', 'concrt',
        'lua', 'tbb', 'qt', 'icu', 'fmod', 'crypt'
    ]
    log('  (filtering to names containing: {})'.format(
        ', '.join(interesting_substrs)))
    log()
    for fn in sorted(os.listdir(rdir)):
        if not fn.lower().endswith('.dll'):
            continue
        if not any(s in fn.lower() for s in interesting_substrs):
            continue
        full = os.path.join(rdir, fn)
        try:
            sz = os.path.getsize(full)
        except Exception:
            sz = -1
        v = file_version_string(full) or '?'
        log('  {:<40s}  size={:>9d}  v={}'.format(fn, sz, v))


def probe_system_crt():
    section('6. SYSTEM32 — modern VC++ runtime DLLs')
    sysdir = os.path.join(
        os.environ.get('SystemRoot', r'C:\Windows'), 'System32')
    names = ['vcruntime140.dll', 'vcruntime140_1.dll',
             'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll',
             'concrt140.dll', 'vcomp140.dll', 'vccorlib140.dll',
             'ucrtbase.dll']
    for n in names:
        p = os.path.join(sysdir, n)
        if os.path.isfile(p):
            v = file_version_string(p) or '?'
            log('  {:<22}  v={:<20}  sha256={}'.format(
                n, v, (file_sha256(p) or '')[:16] + '…'))
        else:
            log('  {:<22}  ** MISSING **'.format(n))


def probe_python_registry():
    section('7. WINDOWS REGISTRY — Python install entries')
    log('  Resolve scripting consults `HKLM/HKCU\\Software\\Python\\PythonCore` to find Python.')
    log('  A stale or wrong entry here can confuse fusionscript at PyInit time.')
    log()
    try:
        import winreg
    except Exception as e:
        log('  winreg import failed: ' + str(e)); return
    for hive_name, hive in (('HKLM', winreg.HKEY_LOCAL_MACHINE),
                            ('HKCU', winreg.HKEY_CURRENT_USER)):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                k = winreg.OpenKey(
                    hive, r'Software\Python\PythonCore', 0,
                    winreg.KEY_READ | view)
            except OSError:
                continue
            view_label = '64' if view == winreg.KEY_WOW64_64KEY else '32'
            try:
                i = 0
                while True:
                    try:
                        v = winreg.EnumKey(k, i); i += 1
                    except OSError:
                        break
                    log('  ' + hive_name + '\\Software\\Python\\PythonCore\\' +
                        v + '  (' + view_label + '-bit view)')
                    try:
                        sub = winreg.OpenKey(k, v + r'\InstallPath')
                        try:
                            ip, _ = winreg.QueryValueEx(sub, '')
                            log('    InstallPath: ' + ip)
                            log('    exists?      ' + str(os.path.isdir(ip)))
                            exe = os.path.join(ip, 'python.exe')
                            log('    python.exe?  ' +
                                str(os.path.isfile(exe)))
                        finally:
                            winreg.CloseKey(sub)
                    except OSError as e:
                        log('    InstallPath: (could not read) ' + str(e))
            finally:
                winreg.CloseKey(k)


def probe_discoverable_pythons():
    """Return a list of (label, path-to-python.exe) we can probe."""
    section('8. DISCOVERABLE PYTHON INTERPRETERS')
    found = []

    # Vendored embeddables — search common locations for a Chiral install.
    chiral_roots = []
    for base in (os.environ.get('USERPROFILE'), DESKTOP):
        if not base: continue
        for root, dirs, _ in os.walk(base):
            depth = root[len(base):].count(os.sep)
            if depth > 3:
                dirs[:] = []   # cap recursion
                continue
            for d in list(dirs):
                if d.lower().startswith('chiral-network'):
                    chiral_roots.append(os.path.join(root, d))
                    dirs.remove(d)   # stop recursing into it
    chiral_roots = sorted(set(chiral_roots))
    for cr in chiral_roots:
        for sub in ('python310', 'python313', 'python'):
            p = os.path.join(cr, 'resources', 'vendor', sub, 'python.exe')
            if os.path.isfile(p):
                found.append(('vendored ' + sub + ' (' + os.path.basename(cr) + ')', p))
            # source-checkout layout
            p2 = os.path.join(cr, 'vendor', sub, 'python.exe')
            if os.path.isfile(p2):
                found.append(('vendored ' + sub + ' (source)', p2))

    # py launcher
    py_launcher = r'C:\Windows\py.exe'
    if not os.path.isfile(py_launcher):
        for d in os.environ.get('PATH', '').split(os.pathsep):
            cand = os.path.join(d, 'py.exe')
            if os.path.isfile(cand):
                py_launcher = cand; break
    if os.path.isfile(py_launcher):
        try:
            out = subprocess.check_output(
                [py_launcher, '--list-paths'],
                stderr=subprocess.STDOUT, timeout=5,
                creationflags=0x08000000).decode('latin-1', errors='replace')
            log('  `py --list-paths` output:')
            for line in out.splitlines():
                log('    ' + line.strip())
                m = re.match(r'\s*-?V?:?(\S+)\s+(.+)$', line.strip())
                if m and m.group(2).lower().endswith('python.exe'):
                    p = m.group(2).strip()
                    if os.path.isfile(p):
                        found.append(('py launcher ' + m.group(1), p))
        except Exception as e:
            log('  py launcher query failed: ' + str(e))

    # Anything on PATH
    for name in ('python.exe', 'python3.exe'):
        for d in os.environ.get('PATH', '').split(os.pathsep):
            p = os.path.join(d, name)
            if os.path.isfile(p):
                found.append(('PATH ' + name + ' (' + d + ')', p))

    # Dedupe by path
    seen = set()
    uniq = []
    for label, p in found:
        ap = os.path.abspath(p)
        if ap in seen: continue
        seen.add(ap)
        uniq.append((label, ap))

    log('')
    log('  found {} interpreters:'.format(len(uniq)))
    for label, p in uniq:
        # Probe version
        try:
            ver = subprocess.check_output(
                [p, '--version'], stderr=subprocess.STDOUT,
                timeout=5, creationflags=0x08000000
                ).decode('latin-1').strip()
        except Exception as e:
            ver = '(version probe failed: ' + str(e)[:80] + ')'
        log('    ' + label + ' :: ' + p + '  -> ' + ver)
    return uniq


CHILD_PROBE_SOURCE = r'''
# child-side import probe. Pre-loads System32 CRTs, sets up Resolve env,
# enables faulthandler, then attempts `import DaVinciResolveScript`. Exit
# code 0 = success, 2 = caught Python exception, anything else (or no exit)
# = process aborted (faulthandler dump file has the C frame).
import os, sys, ctypes, faulthandler, time

FAULT_PATH = sys.argv[1]
fh = open(FAULT_PATH, 'w', encoding='utf-8')
faulthandler.enable(file=fh, all_threads=True)
print('child: python =', sys.version.split()[0], '@', sys.executable)

os.environ.setdefault('RESOLVE_SCRIPT_API',
    r'C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting')
os.environ.setdefault('RESOLVE_SCRIPT_LIB',
    r'C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll')
sys.path.insert(0, os.path.join(os.environ['RESOLVE_SCRIPT_API'], 'Modules'))

resolve_dir = os.path.dirname(os.environ['RESOLVE_SCRIPT_LIB'])
if hasattr(os, 'add_dll_directory') and os.path.isdir(resolve_dir):
    os.add_dll_directory(resolve_dir)

# CRT pre-load (the dev62 fix)
sys32 = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32')
keepalive = []
for n in ('vcruntime140.dll', 'vcruntime140_1.dll',
         'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll',
         'concrt140.dll'):
    p = os.path.join(sys32, n)
    if os.path.isfile(p):
        try:
            keepalive.append(ctypes.WinDLL(p))
            print('child: preloaded', n)
        except OSError as e:
            print('child: PRELOAD FAIL', n, '::', e)

# ctypes preload of fusionscript (dev55)
try:
    from ctypes import wintypes
    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    k32.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]
    k32.LoadLibraryExW.restype = wintypes.HMODULE
    h = k32.LoadLibraryExW(os.environ['RESOLVE_SCRIPT_LIB'], None, 0x08)
    print('child: ctypes preload', 'OK h=0x{:x}'.format(h) if h else 'FAIL')
except Exception as e:
    print('child: ctypes preload exception:', e)

# THE import.
print('child: about to import DaVinciResolveScript')
sys.stdout.flush()
try:
    import DaVinciResolveScript as dvr
    print('child: IMPORT OK')
    sys.exit(0)
except Exception as e:
    print('child: IMPORT RAISED:', type(e).__name__, e)
    import traceback; traceback.print_exc()
    sys.exit(2)
'''


def probe_multi_python_import(interpreters):
    section('9. ★ MULTI-PYTHON IMPORT TEST (the big one)')
    log('  For each Python found, spawn a child process that pre-loads')
    log('  System32 CRTs, enables faulthandler, and attempts:')
    log('       import DaVinciResolveScript')
    log('  Records exit code + faulthandler dump per interpreter.')
    log('  Resolve must be running for scriptapp() — but the import')
    log('  itself should succeed regardless.')
    log()

    # Write the child script once.
    child_path = os.path.join(tempfile.gettempdir(),
                              'chiral_child_probe_' + TS + '.py')
    with open(child_path, 'w', encoding='utf-8') as f:
        f.write(CHILD_PROBE_SOURCE)
    log('  child probe at: ' + child_path)
    log()

    summary = []
    for label, py in interpreters:
        log('  ' + ('-' * 70))
        log('  RUNNING WITH: ' + label)
        log('    ' + py)
        fh_path = os.path.join(
            tempfile.gettempdir(),
            'chiral_child_fh_' + TS + '_' + str(abs(hash(py)) % 10**8) + '.log')
        try:
            r = subprocess.run(
                [py, child_path, fh_path],
                capture_output=True, timeout=30,
                creationflags=0x08000000)
            log('    exit code:   ' + str(r.returncode))
            so = (r.stdout or b'').decode('latin-1', errors='replace')
            se = (r.stderr or b'').decode('latin-1', errors='replace')
            for line in so.splitlines(): log('    stdout: ' + line)
            for line in se.splitlines(): log('    stderr: ' + line)
            fh_dump = ''
            if os.path.isfile(fh_path):
                try:
                    with open(fh_path, 'r', encoding='utf-8',
                              errors='replace') as f:
                        fh_dump = f.read().strip()
                except Exception: pass
            if fh_dump:
                log('    faulthandler dump:')
                for line in fh_dump.splitlines(): log('      ' + line)
            else:
                log('    faulthandler dump: (empty)')
            # Classify exit. Windows access violations come back as
            # 0xC0000005 = 3221225477 unsigned, or as a negative when
            # numpy-fold-via-int. 9009 = ERROR_FILE_NOT_FOUND from the
            # Microsoft Store python.exe reparse-point stub (the real
            # python isn't installed but Windows put a Store-redirect
            # at the path). Treat that as DID NOT RUN, not an abort.
            rc = r.returncode
            if rc == 0:
                outcome = 'OK'
            elif rc == 2:
                outcome = 'EXCEPTION'
            elif rc == 9009 or rc == 1:
                outcome = 'DID NOT RUN'
            elif rc == 3221225477 or rc == -1073741819:
                outcome = 'ACCESS VIOLATION'
            else:
                outcome = 'PROCESS ABORT'
            summary.append((label, outcome, rc))
        except subprocess.TimeoutExpired:
            log('    TIMEOUT (30s)')
            summary.append((label, 'TIMEOUT', None))
        except Exception as e:
            log('    spawn failed: ' + str(e))
            summary.append((label, 'SPAWN FAILED', None))

    log()
    log('  SUMMARY:')
    for label, outcome, rc in summary:
        log('    [{:<20}]  {:<14}  rc={}'.format(outcome, '', rc) +
            '  ' + label)
    return summary


def probe_resolve_scripting_pref():
    section('10. RESOLVE SCRIPTING PREFERENCE')
    log('  Resolve preference "External scripting using" must be Local or Network.')
    log('  If set to None, fusionscript may fast-fail in PyInit.')
    log()

    # Resolve stores prefs under %APPDATA%\Blackmagic Design\DaVinci Resolve\
    appdata = os.environ.get('APPDATA') or ''
    if not appdata:
        log('  APPDATA not set'); return
    base = os.path.join(appdata, 'Blackmagic Design', 'DaVinci Resolve')
    if not os.path.isdir(base):
        log('  Resolve appdata not found at ' + base); return
    log('  scanning under: ' + base)
    hits = []
    for root, dirs, files in os.walk(base):
        for fn in files:
            if fn.lower() in ('config.dat', 'preferences.dat',
                              'config.cfg', 'config.xml', 'davinciresolve.conf'):
                hits.append(os.path.join(root, fn))
    log('  found {} candidate config files'.format(len(hits)))
    for hp in hits:
        log('    ' + hp + '  ({} bytes)'.format(os.path.getsize(hp)))
    # Search for the scripting permission key. Resolve stores it as
    # `Scripting.Mode = N` where N is 0 (None), 1 (Local), 2 (Network).
    # Anything but 1 or 2 means scripting is disabled and fusionscript
    # may fast-fail in PyInit.
    SCRIPT_MODE_LABEL = {b'0': b'None (DISABLED)',
                         b'1': b'Local (OK)',
                         b'2': b'Network (OK)'}
    pat = re.compile(rb'(?i)(scriptin?g|extern)[^\n]{0,80}', re.IGNORECASE)
    mode_pat = re.compile(rb'Scripting\.Mode\s*=\s*(\d+)', re.IGNORECASE)
    for hp in hits[:8]:
        try:
            with open(hp, 'rb') as f:
                blob = f.read()
            for m in pat.finditer(blob):
                line = m.group(0).decode('latin-1', errors='replace')
                line = re.sub(r'[\x00-\x08\x0e-\x1f\x7f]', '·', line)
                log('    ' + hp + ': ' + line[:160])
            mm = mode_pat.search(blob)
            if mm:
                v = mm.group(1)
                lbl = SCRIPT_MODE_LABEL.get(v, b'unknown').decode('latin-1')
                log('    >>> Scripting.Mode = ' + v.decode() +
                    ' -> ' + lbl)
        except Exception as e:
            log('    ' + hp + ': read failed -- ' + str(e))


def probe_processes_and_av():
    section('11. PROCESSES & ANTIVIRUS')
    try:
        out = subprocess.check_output(
            ['tasklist', '/FO', 'CSV', '/NH'],
            stderr=subprocess.STDOUT, timeout=10,
            creationflags=0x08000000).decode('latin-1', errors='replace')
        relevant = ('resolve.exe', 'kaspersky', 'avast', 'mcafee',
                    'bitdefender', 'mssense', 'msmpeng', 'avgnt',
                    'norton', 'avp.exe', 'klhk', 'ekrn',
                    'onedrive', 'dropbox')
        for line in out.splitlines():
            if any(r in line.lower() for r in relevant):
                log('  ' + line.strip())
    except Exception as e:
        log('  tasklist failed: ' + str(e))

    log('')
    log('  registered AV products via WMI/SecurityCenter2:')
    try:
        ps = ('Get-CimInstance -Namespace root\\SecurityCenter2 '
              '-ClassName AntiVirusProduct | '
              'Select-Object displayName, productState, pathToSignedProductExe '
              '| Format-List')
        out = subprocess.check_output(
            ['powershell', '-NoProfile', '-NonInteractive', '-Command', ps],
            stderr=subprocess.STDOUT, timeout=10,
            creationflags=0x08000000).decode('latin-1', errors='replace')
        for line in out.splitlines():
            if line.strip():
                log('    ' + line.strip())
    except Exception as e:
        log('    AV query failed: ' + str(e))


# ============================================================================
# Main
# ============================================================================

def main():
    log('# Chiral Network deep probe')
    log('# Output: ' + LOG_PATH)
    log('# Started: ' + time.strftime('%Y-%m-%d %H:%M:%S'))

    safe('environment',           probe_environment)
    safe('env_vars',               probe_env_vars)
    fs_paths = safe('fusionscript', probe_fusionscript) or []
    safe('resolve_exe',            probe_resolve_exe)
    safe('resolve_dlls',           probe_resolve_dir_dlls)
    safe('system_crt',             probe_system_crt)
    safe('python_registry',        probe_python_registry)
    pys = safe('discoverable_py',  probe_discoverable_pythons) or []
    if pys:
        safe('multi_python_import', probe_multi_python_import, pys)
    else:
        section('9. MULTI-PYTHON IMPORT TEST')
        log('  No Python interpreters discovered to test against.')
        log('  Run this probe under your Chiral vendor python and try again.')
    safe('resolve_pref',           probe_resolve_scripting_pref)
    safe('processes_av',           probe_processes_and_av)

    section('END')
    log('Probe finished: ' + time.strftime('%Y-%m-%d %H:%M:%S'))
    log('Log file:       ' + LOG_PATH)

    # Persist log to disk.
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, 'w', encoding='utf-8') as f:
            f.write('\n'.join(LOG_LINES))
        print('\nLog written to: ' + LOG_PATH)
    except Exception as e:
        print('FAILED to write log: ' + str(e))
        # Fallback to temp dir
        try:
            alt = os.path.join(tempfile.gettempdir(),
                               'chiral_deep_probe_' + TS + '.log')
            with open(alt, 'w', encoding='utf-8') as f:
                f.write('\n'.join(LOG_LINES))
            print('Log written to (fallback): ' + alt)
        except Exception:
            pass


if __name__ == '__main__':
    main()
