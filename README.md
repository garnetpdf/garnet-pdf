# Garnet PDF

A free PDF editor for Windows and Mac that works offline. Edit text and pictures, organise pages, comment,
fill in and sign forms, protect and redact, reduce file size and export. No account, no adverts, no tracking:
the application makes no network requests.

Website and downloads: https://garnetpdf.com

## Licence

Garnet PDF is free software under the GNU Affero General Public License, version 3 (see `LICENSE`).
It is built with MuPDF (Artifex Software, AGPL), Electron, React, pdf.js and other open-source software;
`resources/THIRD-PARTY-NOTICES.txt` lists each one with its licence.

## Build

Requirements: Node.js 22.13 or newer and npm.

    npm ci
    npm run build        # compile the application into out/
    npm run dev          # run it from source

The source package published with each version holds everything needed to build and change the
application. The automated tests and their sample files are kept in the development repository.

### Windows

    npm run dist:win     # installer and portable zip in release/ (built in Docker on Linux)
    npx electron-builder --win nsis --x64     # the same installer, built on Windows itself

The installer is not signed, so Windows shows a warning before it runs. The Microsoft Store package
has no such warning, because the Store signs it:

    npm run dist:store   # on Windows: release/Garnet-PDF-<version>-x64-store.appx

It takes the identity of the Store account from three environment variables (Partner Center, Product
identity): `APPX_IDENTITY_NAME`, `APPX_PUBLISHER` and `APPX_PUBLISHER_DISPLAY_NAME`. The package asks
for nothing but permission to run as a desktop application, and offers itself for PDF files under
"Open with" without becoming the default.

### Mac

    npm run dist:mac     # on a Mac: release/Garnet-PDF-<version>-mac.dmg and -mac.zip

One application for Apple silicon and Intel Macs, macOS 13 (Ventura) or newer. What the script makes
depends on what it is given:

- `CSC_LINK` and `CSC_KEY_PASSWORD` (a "Developer ID Application" certificate as a .p12 file): the
  application and the disk image are signed, the application with the hardened runtime. Its only
  entitlement is `com.apple.security.cs.allow-jit` (`resources/entitlements.mac.plist`), which the
  JavaScript and WebAssembly engine needs.
- `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` as well (an App Store Connect key): Apple
  checks ("notarises") the application and the disk image and the proof is attached to both.
- neither: a locally signed test build. It runs on the Mac that built it; other Macs refuse it.

On a Mac the application keeps one key in the Keychain, "Garnet PDF Safe Storage". It protects the
signatures saved in Fill & Sign and the recovery copies of password-protected files, and is made
the first time one of them is used, never at start. To macOS a build with another signature is
another application: before that build may use the key, macOS asks the person.

### Icons and logos

    npm run icons        # every icon and logo file, from resources/icon.svg and icon-small.svg

Writes the Windows icon, the Mac icon (`icon.icns`, the same drawing in the Mac icon shape), the logos
of the Store package (`resources/appx`), the logos for the Store listing (`resources/store`) and the
background of the Mac disk image.

## Layout

- `src/main`, `src/preload`: the Electron main process and the bridge to the window (`menu.ts` is the
  Mac menu bar, `platform.ts` the window frame of each system)
- `src/renderer`: the interface (React); features are plug-ins under `src/renderer/plugins`
- `src/engine`: PDF work in a worker (opening, drawing, page operations, text, forms, comments, saving)
- `packages/pdf-content`: reading and rewriting page content for object-level edits
- `design/icon`: the icon as a script that draws it

Made by Code2Box, https://code2box.com
