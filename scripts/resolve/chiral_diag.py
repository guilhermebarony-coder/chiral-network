# -*- coding: utf-8 -*-
# chiral_diag.py — pre-import diagnostics for the relink path.
#
# Called by relink_latest_render.py just before `import DaVinciResolveScript`
# (which on some testers' machines access-violates inside fusionscript's
# PyInit callback before any Python exception can be raised). The dev57
# faulthandler captures the crashing C-frame; this module captures the
# *environment* the crash is happening in. Both pieces together let us
# identify the responsible DLL or process state without asking testers to
# run any commands.
#
# DESIGN RULES:
#   * Every probe wrapped in try/except — a probe failure NEVER breaks the
#     relink. We're additive instrumentation, not flow control.
#   * No third-party deps. The embeddable Python ships without pip, so
#     anything beyond the stdlib is unavailable. Win32 calls go through
#     ctypes directly.
#   * Output goes to the caller's `log()` callable (relink_latest_render's
#     log helper, which writes to relink.log under %APPDATA%/Chiral Network/).
#     We don't open files ourselves — the caller already owns the log.
#   * Probes are idempotent and side-effect-free w.r.t. Resolve. Reading a
#     .dll, enumerating loaded modules, listing processes — none of that
#     touches any timeline or shot state.

import os
import sys
import re
import struct
import ctypes
import ctypes.wintypes as wt
import subprocess


# ---- PE parsing -----------------------------------------------------------

def _read_pe_imports(path):
    """Parse a Windows PE file and return the list of imported DLL names.

    Hand-rolled because the stdlib has no PE parser and we can't pull in
    pefile from PyPI in the embeddable. Returns a list of bytes-like names
    (lowercased ascii, e.g. b'python3.dll'), or raises on malformed PE.

    The PE structure we walk:
        DOS header (offset 0x3c)            -> e_lfanew (offset of NT header)
        NT header  (PE\0\0 magic)
        File header                         -> Machine, NumberOfSections
        Optional header                     -> Magic (PE32 vs PE32+),
                                               DataDirectory[1] = Import dir
        Section headers                     -> map RVA -> file offset
        Import descriptor table             -> walk until null entry, each
                                               entry's Name field is RVA of
                                               the imported DLL's name.
    """
    with open(path, 'rb') as f:
        data = f.read()

    if data[:2] != b'MZ':
        raise ValueError("not a PE file (bad MZ signature)")

    e_lfanew = struct.unpack_from('<I', data, 0x3c)[0]
    if data[e_lfanew:e_lfanew + 4] != b'PE\x00\x00':
        raise ValueError("not a PE file (bad PE signature)")

    # IMAGE_FILE_HEADER (20 bytes) starts right after PE\0\0.
    fh_offset = e_lfanew + 4
    machine, num_sections, _ts, _sp, _sn, opt_size, _chars = \
        struct.unpack_from('<HHIIIHH', data, fh_offset)

    # Optional header magic distinguishes PE32 (0x10b) from PE32+ (0x20b).
    # Layouts diverge after Field 22 (BaseOfData missing on PE32+) so the
    # offset to the DataDirectory differs by 16 bytes.
    opt_offset = fh_offset + 20
    magic = struct.unpack_from('<H', data, opt_offset)[0]
    if magic == 0x20b:        # PE32+ (x64)
        data_dir_offset = opt_offset + 112
    elif magic == 0x10b:      # PE32 (x86)
        data_dir_offset = opt_offset + 96
    else:
        raise ValueError("unknown optional header magic: 0x%x" % magic)

    # DataDirectory[1] is the import directory (RVA + Size).
    import_dir_rva, import_dir_size = struct.unpack_from(
        '<II', data, data_dir_offset + 1 * 8)
    if import_dir_rva == 0:
        return []   # no imports — unusual but valid

    # Build RVA -> file-offset map from section table. The section table
    # immediately follows the optional header.
    sect_offset = opt_offset + opt_size
    sections = []
    for i in range(num_sections):
        # Each IMAGE_SECTION_HEADER is 40 bytes.
        s = sect_offset + i * 40
        virt_size = struct.unpack_from('<I', data, s + 8)[0]
        virt_addr = struct.unpack_from('<I', data, s + 12)[0]
        raw_size  = struct.unpack_from('<I', data, s + 16)[0]
        raw_off   = struct.unpack_from('<I', data, s + 20)[0]
        sections.append((virt_addr, virt_addr + max(virt_size, raw_size),
                         raw_off, raw_size))

    def rva_to_file(rva):
        for va_lo, va_hi, raw_off, raw_size in sections:
            if va_lo <= rva < va_hi:
                return raw_off + (rva - va_lo)
        return None

    import_table_off = rva_to_file(import_dir_rva)
    if import_table_off is None:
        raise ValueError("import directory RVA does not map to any section")

    # IMAGE_IMPORT_DESCRIPTOR is 20 bytes. Walk until null entry (all-zero).
    names = []
    i = 0
    while True:
        ent = import_table_off + i * 20
        if ent + 20 > len(data): break
        ilt, _ts, _fwd, name_rva, _iat = struct.unpack_from('<IIIII', data, ent)
        if ilt == 0 and name_rva == 0: break
        nm_off = rva_to_file(name_rva) if name_rva else None
        if nm_off is not None:
            # Names are null-terminated ASCII.
            end = data.find(b'\x00', nm_off)
            if end < 0: end = nm_off + 256
            names.append(data[nm_off:end].lower())
        i += 1
        if i > 1024: break    # paranoia — never seen >100 imports in practice

    return names


def _scan_dll_strings(path, max_bytes=4 * 1024 * 1024):
    """Fallback: regex-scan the head of a binary for `.dll` references.

    Used when full PE parsing fails. Lower confidence than _read_pe_imports
    (matches strings even if they're in code/data, not just import table)
    but always works and gives us a coarse signal."""
    with open(path, 'rb') as f:
        head = f.read(max_bytes)
    return sorted(set(re.findall(rb'[A-Za-z0-9_\-\.]+\.dll', head, re.IGNORECASE)))


def dump_fusionscript_imports(lib_path, log):
    """Log fusionscript.dll's PE imports + string scan + version info."""
    log("--- fusionscript.dll inspection ---")
    if not lib_path:
        log("  RESOLVE_SCRIPT_LIB not set"); return
    if not os.path.isfile(lib_path):
        log("  file does not exist: " + lib_path); return

    try:
        st = os.stat(lib_path)
        log("  size:  {} bytes".format(st.st_size))
        import time as _time
        log("  mtime: " + _time.strftime("%Y-%m-%d %H:%M:%S",
                                         _time.localtime(st.st_mtime)))
    except Exception as e:
        log("  stat failed: " + str(e))

    # PE parse — high signal.
    try:
        imports = _read_pe_imports(lib_path)
        log("  PE imports ({}):".format(len(imports)))
        for nm in imports:
            log("    " + nm.decode('latin-1'))
    except Exception as e:
        log("  PE parse failed: " + str(e))
        # Fallback string scan.
        try:
            hits = _scan_dll_strings(lib_path)
            log("  string-scan .dll matches ({}):".format(len(hits)))
            for nm in hits:
                log("    " + nm.decode('latin-1'))
        except Exception as e2:
            log("  string scan also failed: " + str(e2))


# ---- Loaded module enumeration --------------------------------------------

def dump_loaded_modules(log):
    """Enumerate DLLs currently loaded into THIS python.exe process via
    Win32 EnumProcessModulesEx. Logs full path + base address + size for
    each module. Reveals wrong-version DLLs loaded from unexpected
    locations (e.g. an old python3.dll picked up from Resolve's install
    dir, or a Defender shim injected ahead of fusionscript)."""
    log("--- loaded modules (EnumProcessModulesEx) ---")
    try:
        psapi  = ctypes.WinDLL('psapi',   use_last_error=True)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        hproc  = kernel.GetCurrentProcess()

        # Allocate room for 1024 module handles. EnumProcessModulesEx fills
        # cbNeeded with the byte count it would have written. Resize once
        # if we under-allocated.
        HMODULE = wt.HMODULE
        ARRAY_SZ = 1024
        modules = (HMODULE * ARRAY_SZ)()
        cb_needed = wt.DWORD(0)

        # LIST_MODULES_ALL = 0x03 (32+64 bit modules in a wow64 process; on
        # native x64 this just returns everything).
        psapi.EnumProcessModulesEx.argtypes = [
            wt.HANDLE, ctypes.POINTER(HMODULE), wt.DWORD,
            ctypes.POINTER(wt.DWORD), wt.DWORD]
        psapi.EnumProcessModulesEx.restype = wt.BOOL

        ok = psapi.EnumProcessModulesEx(
            hproc, modules, ctypes.sizeof(modules),
            ctypes.byref(cb_needed), 0x03)
        if not ok:
            err = ctypes.get_last_error()
            log("  EnumProcessModulesEx failed: error {}".format(err))
            return

        count = min(ARRAY_SZ, cb_needed.value // ctypes.sizeof(HMODULE))
        log("  module count: {}".format(count))

        # GetModuleFileNameExW for the path of each module.
        psapi.GetModuleFileNameExW.argtypes = [
            wt.HANDLE, HMODULE, wt.LPWSTR, wt.DWORD]
        psapi.GetModuleFileNameExW.restype = wt.DWORD

        # GetModuleInformation gives us load-base + image size — useful for
        # detecting two copies of the same DLL loaded simultaneously.
        class MODULEINFO(ctypes.Structure):
            _fields_ = [
                ("lpBaseOfDll", ctypes.c_void_p),
                ("SizeOfImage", wt.DWORD),
                ("EntryPoint",  ctypes.c_void_p),
            ]
        psapi.GetModuleInformation.argtypes = [
            wt.HANDLE, HMODULE, ctypes.POINTER(MODULEINFO), wt.DWORD]
        psapi.GetModuleInformation.restype = wt.BOOL

        buf = ctypes.create_unicode_buffer(1024)
        for i in range(count):
            try:
                got = psapi.GetModuleFileNameExW(hproc, modules[i], buf, 1024)
                if not got:
                    continue
                mi = MODULEINFO()
                psapi.GetModuleInformation(
                    hproc, modules[i], ctypes.byref(mi), ctypes.sizeof(mi))
                base = mi.lpBaseOfDll or 0
                size = mi.SizeOfImage or 0
                log("  [0x{:016x}+0x{:08x}] {}".format(base, size, buf.value))
            except Exception as e:
                log("  module {} probe failed: {}".format(i, e))
    except Exception as e:
        log("  module enumeration crashed: " + str(e))


# ---- VC runtime probe -----------------------------------------------------

_VC_RUNTIME_DLLS = (
    "vcruntime140.dll",
    "vcruntime140_1.dll",   # added in MSVC 2019 14.20+ — common culprit
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_2.dll",
    "concrt140.dll",
    "vcomp140.dll",
)

def _file_version_str(path):
    """Read VS_FIXEDFILEINFO from a Windows binary. Returns 'a.b.c.d' or
    None on any failure."""
    try:
        version = ctypes.WinDLL('version', use_last_error=True)

        version.GetFileVersionInfoSizeW.argtypes = [
            wt.LPCWSTR, ctypes.POINTER(wt.DWORD)]
        version.GetFileVersionInfoSizeW.restype = wt.DWORD

        dummy = wt.DWORD(0)
        size = version.GetFileVersionInfoSizeW(path, ctypes.byref(dummy))
        if not size: return None

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
        if not version.VerQueryValueW(buf, "\\", ctypes.byref(ptr), ctypes.byref(plen)):
            return None

        # VS_FIXEDFILEINFO: skip dwSignature(4), dwStrucVersion(4) -> next
        # 8 bytes are dwFileVersionMS / LS, big-endian-encoded as 4 WORDs.
        ffi = ctypes.string_at(ptr.value, 16)
        ms_hi, ms_lo = struct.unpack('<HH', ffi[8:12])
        ls_hi, ls_lo = struct.unpack('<HH', ffi[12:16])
        # Field order in the struct: HIWORD then LOWORD for MS; same for LS.
        # MS = (major << 16) | minor; LS = (build << 16) | revision.
        return "{}.{}.{}.{}".format(ms_lo, ms_hi, ls_lo, ls_hi)
    except Exception:
        return None


def dump_vc_runtime(log):
    """For each modern VC++ runtime DLL fusionscript could need, probe
    System32 + the embeddable's bundled copy. Report presence + version."""
    log("--- VC runtime DLLs ---")
    sysdir = os.environ.get("SystemRoot", r"C:\Windows") + r"\System32"
    embed_dir = os.path.dirname(sys.executable) if sys.executable else ""

    for name in _VC_RUNTIME_DLLS:
        for label, d in (("system32", sysdir), ("embed   ", embed_dir)):
            if not d: continue
            p = os.path.join(d, name)
            if os.path.isfile(p):
                v = _file_version_str(p) or "?"
                log("  {}  {:<22}  {}  v={}".format(label, name, p, v))
            # Don't log misses for the embed dir — most VC DLLs live in
            # System32, not the embeddable. We only care that the file
            # SOMEWHERE on the loader's search path is reachable.
            elif label == "system32":
                log("  {}  {:<22}  ** MISSING **".format(label, name))


# ---- Resolve process check ------------------------------------------------

def dump_resolve_process(log):
    """Log whether Resolve.exe is currently running. fusionscript's PyInit
    is suspected to attach to a Resolve IPC channel; if Resolve isn't up,
    that attachment may fault before scriptapp() is ever called."""
    log("--- Resolve process check ---")
    try:
        out = subprocess.check_output(
            ["tasklist", "/FI", "IMAGENAME eq Resolve.exe", "/FO", "CSV", "/NH"],
            stderr=subprocess.STDOUT, timeout=5,
            creationflags=0x08000000  # CREATE_NO_WINDOW
        )
        text = out.decode('latin-1', errors='replace').strip()
        if not text or "INFO:" in text or "No tasks" in text:
            log("  Resolve.exe NOT running (relink will fail at scriptapp())")
        else:
            for line in text.splitlines():
                log("  " + line.strip())
    except subprocess.TimeoutExpired:
        log("  tasklist timed out (5s) — skipping")
    except Exception as e:
        log("  tasklist failed: " + str(e))


# ---- Antivirus enumeration ------------------------------------------------

def dump_antivirus(log):
    """Enumerate registered antivirus products via WMI's SecurityCenter2
    namespace. PowerShell one-shot — no WMI imports in our embeddable.
    Doesn't change behavior; just tells us which AV is active when a
    crash signature suggests injected DLLs as the cause."""
    log("--- antivirus products ---")
    try:
        # NOTE on quoting: we pass argv as a list, so each '-Command' arg is
        # one token and no shell quoting is involved. The PS expression is
        # inline; it's fine to embed quotes.
        ps = ("Get-CimInstance -Namespace root\\SecurityCenter2 "
              "-ClassName AntiVirusProduct | "
              "Select-Object displayName, productState | Format-List")
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            stderr=subprocess.STDOUT, timeout=10,
            creationflags=0x08000000)
        text = out.decode('latin-1', errors='replace').strip()
        if text:
            for line in text.splitlines():
                if line.strip():
                    log("  " + line.strip())
        else:
            log("  (none reported)")
    except subprocess.TimeoutExpired:
        log("  PowerShell AV query timed out (10s) — skipping")
    except Exception as e:
        log("  AV query failed: " + str(e))


# ---- Aggregate ------------------------------------------------------------

def run_all(lib_path, log):
    """Run every probe in sequence. Each probe is wrapped in its own
    try/except so a failure in one doesn't gate the others. Output is
    bracketed by a clear header so it's grep-able in relink.log."""
    log("==== chiral_diag start ====")
    for fn, args in (
        (dump_fusionscript_imports, (lib_path, log)),
        (dump_vc_runtime,           (log,)),
        (dump_loaded_modules,       (log,)),
        (dump_resolve_process,      (log,)),
        (dump_antivirus,            (log,)),
    ):
        try:
            fn(*args)
        except Exception as e:
            log("probe {} crashed: {}".format(fn.__name__, e))
    log("==== chiral_diag end ====")
