<sub>🇺🇸 [English](README.md) &nbsp;·&nbsp; 🇧🇷 **Português**</sub>

# Chiral Network

> **🚧 Status: 100% vibecoded, atualmente em Pre-Alpha.** Construído de
> ponta a ponta em uma longa sessão de pair-programming com o Claude.
> Coisas vão quebrar, mudar de forma e ser reescritas. O feedback dos
> testadores é o objetivo desta fase — abra issues sem cerimônia.

> **Ponte profissional de automação de workflow entre o DaVinci Resolve
> e o Adobe After Effects.** Marca → comp → render → relink, ponta a
> ponta, em um único atalho. Você fica no seu editor — o Chiral Network
> cuida da burocracia.

O Chiral Network é um app Electron para Windows que se posiciona entre
o Resolve e o After Effects. Ele observa o Resolve em busca de trechos
marcados na timeline, entrega o clipe para o AE com uma comp já
montada, monitora os renders e relinka silenciosamente o novo master
de volta para o Resolve no frame correto — colorido por nível de
qualidade.

---

## Por que "Chiral"?

As duas metades do workflow são imagens espelhadas uma da outra — um
shot de entrada do Resolve é uma comp de saída do AE; um render de
saída do AE é um clipe de entrada do Resolve. O Chiral Network mantém
a "lateralidade" consistente ao longo do loop: todo shot Resolve-first
sabe achar sua comp no AE, todo shot AE-first sabe onde aterrissar na
timeline do Resolve. A quiralidade é o contrato.

---

## Pitch de elevador

Marque IN/OUT no Resolve, rode **Workspace → Scripts → Utility →
export_range**. Uma nova pasta de shot aparece no seu diretório de
projetos com um `reference.mp4` da sua timeline. Clique em **Open in
After Effects** no Chiral Network — o AE abre com uma comp 1080p já
montada e o reference já importado. Anime. Aperte **Render new
version**. O AE renderiza desacoplado; o Chiral Network monitora a
conclusão e roda o Python de relink do Resolve. Sua timeline do
Resolve agora reproduz o master do AE no frame exato que você marcou.

O mesmo workflow no sentido inverso: abra o AE, clique em **New shot
from AE** — a ponte lê sua comp ativa, constrói um shot no formato do
Resolve, e o primeiro render é inserido no Resolve no playhead.

---

## Três pilares

### 🔁 A Ponte AE ↔ Resolve

O loop principal. Python do lado Resolve (`scripts/resolve/`) conversa
com a Studio scripting API. ExtendScript do lado AE
(`scripts/ae/`) dirige o After Effects via dispatch `-r`. O app
Electron (`app/`) é o maestro que detém o modelo de shot em disco e
roteia eventos entre os dois lados.

A atomicidade é garantida em todo lugar: `job.json`, `settings.json`,
`renderjob.json`, `.relink.json` e `.render-progress.json` usam tmp +
fsync + rename. Renders desacoplados do AE transmitem progresso via
`.render-progress.json` de dentro do JSX, então a barra de status
mostra `Rendering vXX · 12s elapsed (AE)` em tempo real, sem
acoplamento via IPC. Transações de stage-dir (`.tmp_<shot>/` + rename
atômico) garantem que um handoff falho do AE nunca deixa nada
meio-construído em `projects/`.

### 📚 Gerenciamento de Assets (Vault)

Uma biblioteca de assets reusáveis por instalação — backgrounds,
templates de layer, lower-thirds, qualquer coisa que você importaria
shot após shot. Itens da Vault renderizam thumbnails na ingestão,
carregam metadata pesquisável (nome, tags, tipo, tamanho) e fazem
import com um clique para a comp do AE atualmente aberta usando o
mesmo canal ExtendScript da ponte.

A página da Vault (sidebar → **Vault**) suporta tanto uma grade de
cards quanto uma visão de lista densa (com colunas `SIZE`, `MODIFIED`,
`TYPE`), filtro por texto livre e uma lixeira soft-delete com retenção
de 7 dias. Um índice de Vault (`vault/.index.json`) é reconstruído
oportunisticamente — re-escaneia apenas quando os mtimes do diretório
subjacente mudaram.

### 📦 Rastreamento de Versões

Cada render é uma versão numerada (`v01/`, `v02/`, …) dentro do shot.
Cada uma carrega o master, um preview `.webm` opcional e um
`render.json` com metadados de formato / scale / origem que orientam
o nível de qualidade (Draft / Preview / High / Final) e a cor na
timeline.

Os version cards na página de shot expõem tudo isso — escolha
qualquer versão prévia para torná-la ativa, e o Chiral Network re-roda
o relink do Resolve para trocar a referência da timeline. **Sanity
dots** por shot (vermelho > amarelo > verde) agregam dos health
checks por versão; o rail de projetos mostra o pior dot por projeto,
para que você veja problemas em todo o show de relance.

---

## Outras features que valem destaque

- **Project Rail** — sidebar vertical estilo IDE (240 px expandido,
  48 px colapsado), Hover-Peek como overlay flutuante sem reflow do
  workspace.
- **Project Overview** — clique no nome do projeto no rail ou na
  breadcrumb para uma visão de cards / lista de cada shot, com preview
  da versão ativa, seleção em batch para operações em massa, e totais
  de SIZE por shot.
- **Banner de chegada cross-project** — quando um render termina para
  um shot em um projeto que você não está atualmente, você recebe um
  banner não-disruptivo em vez de ser teleportado para lá no meio da
  edição.
- **Shot Jump Palette (Ctrl+Space)** — launcher de shots com fuzzy
  match. Subsequence matching estilo VS Code: `s10hr` casa com
  `Shot_010_hero`. Pré-seleciona o shot atual ao abrir.
- **Origin badges** — pílulas `RV` (Resolve-first) e `AE` (AE-first)
  tornam a quiralidade visível no rail, breadcrumb e menus de contexto.
- **Soft delete** — deletes de shot vão para uma `.trash/` por projeto
  com retenção de 7 dias. Deletes de projeto ainda mostram o diálogo
  de aviso com o caminho completo.
- **Refresh por filesystem** — `fs.watch` (com debounce) substitui o
  tick de polling de 3s. Pegada ociosa de CPU é praticamente zero; a
  UI pausa watchers quando a janela está oculta.

---

## Pré-requisitos de instalação

| Componente                       | Versão             | Notas                                       |
|----------------------------------|--------------------|---------------------------------------------|
| Windows                          | 10 ou 11, 64 bits  | Suporte para macOS está no roadmap.         |
| DaVinci Resolve / Resolve Studio | 18.6+ (20.x ideal) | A scripting API do Studio é necessária.     |
| Adobe After Effects              | 2022 ou mais novo  | ExtendScript / dispatch `-r` é usado.       |
| Python (vendored)                | **3.10.x**         | Ver nota abaixo.                            |
| ffmpeg                           | qualquer build recente | Opcional — só para previews `.webm`.    |
| Node.js (apenas dev)             | 18 LTS ou mais novo | Não é necessário para usuários finais.    |

**Python 3.10 é obrigatório.** O `fusionscript.dll` do Resolve é uma
extensão C do CPython compilada contra um único ABI de Python no
Windows — atualmente 3.10. O build empacotado do Chiral Network já
traz CPython 3.10.11 dentro de `resources/vendor/python/`, então você
não precisa instalar nada por conta própria. Se está rodando do source
e o relink falhar com `ImportError: DLL load failed while importing
fusionscript`, seu interpretador é da minor errada — coloque um
embeddable 3.10 em `vendor/python/`.

O Setup Wizard cuida de tudo na primeira execução:

1. Detecta um Python instalado e o registra para a scripting do Resolve.
2. Opcionalmente baixa um Python e ffmpeg vendorados em `vendor/`,
   tornando o app self-contained.
3. Copia os scripts do lado Resolve para a pasta
   `%APPDATA%/Blackmagic Design/DaVinci Resolve/Support/Fusion/Scripts/Utility/`.
4. Cria a raiz de projetos e popula `config.json`.

Se algo quebrar depois, o botão **Repair installation** no menu
"overflow" reroda cada etapa e reporta status componente a componente.

---

## Onde as coisas ficam em disco

| Caminho                                  | O que tem lá                                         |
|------------------------------------------|------------------------------------------------------|
| `%APPDATA%/Roundtrip/`                   | Config do app, logs, índice da vault. **O caminho é preservado dos dias pré-rebrand do Roundtrip para que instalações existentes atualizem in-place — isso é intencional, não uma referência defasada.** |
| `%APPDATA%/Roundtrip/logs/relink.log`    | Saída do Python de relink Resolve→AE. Primeiro lugar a olhar em qualquer erro de "relink failed". |
| `%APPDATA%/Roundtrip/logs/export_range.log` | Script do Resolve para "send to AE".              |
| `<projects root>/<project>/<shot>/`      | Pasta por shot: `source/`, `renders/v01..vNN/`, `.trash/` (shots soft-deletados), `job.json`. |
| `<projects root>/<project>/.vault/`      | Biblioteca de assets + thumbnails por projeto.       |
| `resources/vendor/python/`               | CPython 3.10 vendorado (apenas em builds empacotados). |
| `resources/vendor/ffmpeg/`               | ffmpeg vendorado (apenas em builds empacotados).     |

---

## Como reportar problemas

O Chiral Network roteia erros por um único canal — a **status strip**
persistente ao longo da parte de baixo da janela. Quando algo falha:

1. **Anote o texto da strip** literalmente. Erros vêm no formato
   `<operação> failed: <razão>`.
2. **Pegue o log relevante.** Os logs ficam em `%APPDATA%/Roundtrip/logs/`:
   - `export_range.log` — script do Resolve para "send to AE".
   - `relink.log` — relink AE→Resolve (por render).
3. **Encontre o `.relink.json` do shot** se a falha foi durante um
   relink. Ele carrega `{ ok: false, error: "<razão>" }` e é o
   postmortem de uma linha mais preciso que temos.
4. **Abra uma issue** com:
   - O texto da status strip.
   - As últimas ~30 linhas do log relevante.
   - O conteúdo do `.relink.json` se aplicável.
   - Seu build do Resolve (`Help → About`), versão do AE, e o
     `python --version` do interpretador vendorado.

O botão **Repair installation** (menu "overflow", canto superior
direito) é o primeiro passo certo para qualquer coisa que tenha cara
de problema de ambiente.

---

## Desenvolvimento

```bash
git clone https://github.com/guilhermebarony-coder/chiral-network.git
cd chiral-network
npm install --prefix app
npm start --prefix app
```

O app Electron mora em `app/`. Os scripts Python do lado Resolve
moram em `scripts/resolve/`. Os arquivos JSX ExtendScript do After
Effects moram em `scripts/ae/`. Notas de arquitetura estão inline no
topo de cada arquivo — comece por `app/main.js` e `app/lib/job.js`
para a ponte, depois `scripts/resolve/relink_latest_render.py` para a
metade Resolve.

Os testes são `node --test` puro:

```bash
cd app && npm test
```

`vendor/` (interpretador Python e ffmpeg) **não está no repo**
intencionalmente — é distribuído via GitHub Releases como
`vendor.zip`. Coloque o conteúdo em `vendor/` após clonar para deixar
o app self-contained ao rodar do source.

---

## Releases

Builds para testers e produção são anexados como ZIPs / RARs na
[página de Releases](https://github.com/guilhermebarony-coder/chiral-network/releases).
Substitua sua pasta `Chiral-Network-x.y.z-x64/` existente por inteiro
— nenhuma migração de settings é necessária; dados do usuário ficam
em `%APPDATA%/Roundtrip/` e sobrevivem entre versões.

O build atual de tester pre-alpha é **0.5.0-dev55**. Veja
[`CHANGELOG.md`](CHANGELOG.md) para o histórico completo de versões.

---

Licença: MIT (ver [LICENSE](LICENSE)).
