# Packaging notes

What electron-builder's NSIS target actually does, learned by reading its
templates and then breaking it. The point is to save the next person the
same afternoon.

Source of truth: `node_modules/app-builder-lib/templates/nsis/` and
`out/targets/nsis/NsisTarget.js`. Read those, not the docs — the docs do not
mention the include-order problem below, and it is the thing that blocks you.

## What we have

`apps/desktop/package.json` → `build` → `nsis`:

| Key | Value | Why |
|---|---|---|
| `oneClick` | `false` | An assisted installer, not a silent one. A one-click installer cannot show a wizard, and the requirement is a wizard. |
| `allowToChangeInstallationDirectory` | `true` | The directory-choice page. |
| `license` | `"../../LICENSE"` | The licence page. **Verified**: the built installer shows "License Agreement" with the MIT text. |
| `createDesktopShortcut` | `true` | |
| `createStartMenuShortcut` | `true` | |
| `deleteAppDataOnUninstall` | `false` | |

**Verified on this machine** (not inferred): the installer runs, shows the
licence page, installs to a chosen directory, creates shortcuts on the desktop
and in the Start menu, and the packaged `Openfield.exe` launches. The
uninstaller is present.

## The hook for a custom page

`assistedInstaller.nsh` has exactly one hook for a page of your own, and it
sits between the directory choice and the install — which is where a shortcut
options page belongs:

```nsis
!ifmacrodef customPageAfterChangeDir
  !insertmacro customPageAfterChangeDir
!endif
```

Other hooks: `customWelcomePage`, `customFinishPage`, `customUnWelcomePage`,
`customUninstallPage`, `customInstall`, `customUnInstall`, `customInstallMode`.

## The trap: your `nsis.include` is processed before MUI2

Setting

```json
"nsis": { "include": "build/installer.nsh" }
```

and then using `!insertmacro MUI_PAGE_FUNCTION_CUSTOM PRE` in that file fails
with:

```
!insertmacro: macro named "MUI_PAGE_FUNCTION_CUSTOM" not found!
```

The user include is added to the script **before** `MUI2.nsh` is included, so
no MUI2 macro exists yet. Adding `!include "MUI2.nsh"` to the top of your own
file gets past that and then fails again — electron-builder treats NSIS
warnings as errors, so the redefinition warning is fatal:

```
Error: warning treated as error
```

**So: a custom page cannot be written in an `nsis.include` file with MUI2
macros.** The two obvious routes both dead-end. The way out is probably to
avoid the MUI2 page macros entirely and drive the page with `nsDialogs` alone
— which is available, because `multiUserUi.nsh` uses it — and to set the header
text with a plain `nsDialogs` label rather than `MUI_HEADER_TEXT`.

## What is available for the page

`nsDialogs.nsh` ships with the cached NSIS and is on the include path:

- `${NSD_CreateCheckBox} dx dy w h text` — creates a checkbox, `Pop`s the id
- `${NSD_GetChecked} control var` — reads the state
- `${NSD_Check} control` / `${NSD_Uncheck} control` — sets it
- `${NSD_CreateLabel} dx dy w h text`, `${NSD_CreateRadioButton} ...`
- `nsDialogs::Create 1018` — the MUI2 dialog resource the templates use

The pattern that works, from `multiUserUi.nsh`:

```nsis
!insertmacro MUI_PAGE_FUNCTION_CUSTOM PRE
nsDialogs::Create 1018
Pop $0
${NSD_CreateCheckBox} 10u 50u 280u 20u "Create a &desktop shortcut"
Pop $chk
${NSD_Check} $chk
!insertmacro MUI_PAGE_FUNCTION_CUSTOM SHOW
nsDialogs::Show
```

Read the state in the page's **leave** function, not later: the control handle
does not survive the page.

## The other trap: shortcuts are compile-time

electron-builder creates the shortcuts unconditionally, from the config
booleans. There is no runtime path to "ask the user". A shortcut options page
therefore needs:

1. `createDesktopShortcut: false` and `createStartMenuShortcut: false` in the
   config, so the template does not create them; and
2. `customInstall` creating them from the user's answers; and
3. `customUnInstall` removing them. Deleting a shortcut that was never created
   is a no-op, so the uninstaller can remove both unconditionally and the
   answers do not need recording.

## Building

```bash
cd apps/desktop
node bin/dev.mjs --package        # vite only
npx electron-builder --win nsis portable
```

`node bin/dev.mjs --package` **does not run electron-builder** — it only
builds the renderer and the main process. The `dist` script in
`apps/desktop/package.json` is the one that packages:

```
"dist": "node bin/dev.mjs --package && electron-builder --win nsis portable"
```

electron-builder must run with `cwd` set to `apps/desktop`, because it
resolves its configuration from the `package.json` of the directory it is
invoked in.

## The artefact

`release/Openfield-0.1.0-x64.exe` — an NSIS installer, about 84 MB. The version
comes from `package.json` and the name from `build.artifactName`, so the
version string lives in exactly one place.

## Still to do

`PKG-0002` — the shortcut creation options page. The research is done; the page
is not written. Everything below is what the attempts established, so the next
attempt starts from the answers rather than from the failures.

### What blocks it

electron-builder adds a user-supplied `nsis.include` to the script **before**
`MUI2.nsh` is included, and `!insertmacro` is resolved in parse order. So a
macro defined later does not exist yet:

```
!insertmacro: macro named "MUI_PAGE_FUNCTION_CUSTOM" not found!
```

Adding `!include "MUI2.nsh"` to the top of the file fails again, because
electron-builder treats NSIS warnings as errors and the redefinition is one.

### The four dead ends, in order

1. **`Page custom fn` inside `customPageAfterChangeDir`** — compiles, but the
   *leave* function that reads the checkboxes is never referenced, because
   `Page custom` only references the create function. NSIS warns
   (`warning 6010: install function "..." not referenced`) and the build fails,
   because electron-builder treats warnings as errors.

2. **`PageEx custom fn leave`** — `PageEx expects 1 parameters, got 3` in this
   NSIS version.

3. **Declaring the functions at the top level of the include** — the file is
   included in *both* the installer and the uninstaller script, and the page is
   only inserted in the installer. So the functions and the `Var` declarations
   are unreferenced in the uninstaller (`warning 6010` and `warning 6001`).

   The fix is to put the page, the functions *and* the variables inside one
   macro, and insert that macro from `customPageAfterChangeDir`, so they all
   appear together or not at all.

4. **Inserting that macro inside the `PageEx` block** — `command Function not
   valid in PageEx`. The `PageEx custom` block extends past the `!insertmacro`,
   so the `Function` definitions land inside it.

### What the multi-user page in the same toolchain does

`node_modules/app-builder-lib/templates/nsis/multiUserUi.nsh` is the working
example, and it is in the same NSIS build:

```nsis
PageEx custom

  PageCallbacks MultiUser.InstallModePre_${MUI_UNIQUEID} MultiUser.InstallModeLeave_${MUI_UNIQUEID}

  Caption " "
```

`PageCallbacks` is how the create and leave functions are attached — that is
the piece that solves dead end 1 without needing an MUI2 macro.

### Where to go next

The remaining question is how to end the `PageEx` block before the function
definitions. The multi-user file manages it; reading the lines after that block
in `multiUserUi.nsh` is the next thing to try.

### The other half

electron-builder creates the shortcuts **unconditionally**, from compile-time
booleans. There is no runtime path to "ask the user". So the config booleans
have to be off and the installer has to create the shortcuts itself, from the
answers:

- `customInstall` creates them
- `customUnInstall` removes them — unconditionally, because deleting a shortcut
  that was never created is a no-op, and that is much simpler than recording the
  answers for the uninstaller to read back

`PKG-0003` — the portable ZIP — is done: a zip target and a portable
single-exe build are both produced, and the archive was opened and checked to
contain the whole app.


## 0.2.0 rebuild: a space in the install path installs nothing

Found this while installing the 0.2.0 build (23 Oct 2026) and reproduced twice.
It is the reason an "installed" copy can look untouched after a successful
installer run.

**Symptom.** The installer runs, exits `0`, writes the uninstall registry entry
and writes both shortcuts - and the install directory stays empty. The
uninstall string it writes is `"C:\Users\Alex\Uninstall Openfield.exe"`,
truncated at the first space of the real profile path
(`C:\Users\Alex Doe\...`).

**Cause (observed, not yet read to the line).** The default `$INSTDIR` is
`$LOCALAPPDATA\Programs\Openfield`, and on this machine `%LOCALAPPDATA%` is
`C:\Users\Alex Doe\AppData\Local`. Something between that value and the
`SetOutPath`/extract step splits it at the space, so the installer aims at
`C:\Users\Alex` - which does not exist and cannot be created unelevated -
and the file copy silently does nothing.

**Proof.** Same installer, same command line, only the target differs:

| Target given by `/D=` | Files in the target |
|---|---|
| (none, default) | 0, plus `C:\Users\Alex`-based uninstall string |
| `C:\Users\Alex Doe\of-test` | 0 |
| `C:\of-test` | 20 entries, app.asar reports 0.2.0 |
| `C:\Openfield` | 20 entries, app.asar reports 0.2.0, shortcuts point here |

Silent install is the path used above (`installer.exe /S /D=<path>`); `/D=`
must be last and must not be quoted. From PowerShell, `Start-Process
-ArgumentList` quotes it and breaks the install - drive the installer from a
`.bat` file instead.

**Workaround used.** `C:\Openfield` - a path with no space - is the installed
copy on this machine, because every path under this user's profile contains
one. Any user whose Windows account name contains a space hits the same wall.

**Next.** Read `installApplication` in
`node_modules/app-builder-lib/templates/nsis/installer.nsh` for the unquoted
`$INSTDIR` that produces the truncation; either quote it or set a default
`$INSTDIR` that survives the round trip.
