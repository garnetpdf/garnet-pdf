// Builds the Microsoft Store package on Windows: release/Garnet-PDF-<version>-x64-store.appx
//
// The identity of the package comes from the Store account (Partner Center, "Product identity") and
// is passed in the environment, never written into the repository:
//
//   APPX_IDENTITY_NAME            Package/Identity/Name, for example 12345Code2Box.GarnetPDF
//   APPX_PUBLISHER                Package/Identity/Publisher, for example CN=01234567-89AB-CDEF-0123-456789ABCDEF
//   APPX_PUBLISHER_DISPLAY_NAME   the publisher name people see, for example Code2Box
//
// APPX_PACKAGE_LABEL (optional, "store" when not set) is the last word of the file name. A package made
// for testing is given another label so that it can never be mistaken for the one for the Store.
//
// The package is left unsigned: the Store signs it when it is published. To try it on a test machine,
// sign it with a certificate whose subject is exactly APPX_PUBLISHER and trust that certificate on the
// machine (the build machines do this with a throw-away certificate).
//
// Run: node scripts/dist-store.mjs            (after npm run build)
import console from 'node:console';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** The three values, checked the way Windows checks them, or a list of what is wrong. */
export function storeIdentity(env) {
  const identityName = (env.APPX_IDENTITY_NAME || '').trim();
  const publisher = (env.APPX_PUBLISHER || '').trim();
  const publisherDisplayName = (env.APPX_PUBLISHER_DISPLAY_NAME || '').trim();
  const problems = [];
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(identityName))
    problems.push(
      'APPX_IDENTITY_NAME must be 3 to 50 letters, digits, dots or dashes (Partner Center: Package/Identity/Name).',
    );
  if (!/^(CN|O|OU|L|S|C|E)=.+/.test(publisher))
    problems.push(
      'APPX_PUBLISHER must be the publisher exactly as Partner Center shows it, starting with CN= (Package/Identity/Publisher).',
    );
  if (!publisherDisplayName || publisherDisplayName.length > 256)
    problems.push('APPX_PUBLISHER_DISPLAY_NAME must be the publisher name people see.');
  const label = (env.APPX_PACKAGE_LABEL || 'store').trim();
  if (!/^[a-z0-9-]{1,30}$/.test(label))
    problems.push('APPX_PACKAGE_LABEL must be 1 to 30 small letters, digits or dashes.');
  return { identityName, publisher, publisherDisplayName, label, problems };
}

/**
 * The settings of the Store package with this identity, on top of electron-builder.yml. They go
 * through a file, so that a publisher such as "CN=Name, O=Company" arrives exactly as written.
 */
export function storeConfig({ identityName, publisher, publisherDisplayName, label = 'store' }) {
  return {
    extends: 'electron-builder.yml',
    appx: {
      identityName,
      publisher,
      publisherDisplayName,
      artifactName: `Garnet-PDF-\${version}-\${arch}-${label}.\${ext}`,
    },
  };
}

function main() {
  const identity = storeIdentity(process.env);
  if (identity.problems.length) {
    console.error(`The Store package cannot be built:\n  ${identity.problems.join('\n  ')}`);
    process.exit(1);
  }
  if (process.platform !== 'win32') {
    console.error('The Store package is built on Windows (it needs the Windows packaging tools).');
    process.exit(1);
  }
  console.log(
    `Store package (${identity.label}) for ${identity.identityName}, publisher ${identity.publisherDisplayName}`,
  );
  // No certificate is used: the package is for the Store, which signs it.
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  delete env.CSC_LINK;
  delete env.WIN_CSC_LINK;
  mkdirSync('release', { recursive: true });
  writeFileSync('release/store-config.json', `${JSON.stringify(storeConfig(identity), null, 2)}\n`);
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/electron-builder/cli.js',
      '--config',
      'release/store-config.json',
      '--win',
      'appx',
      '--x64',
      '--publish',
      'never',
    ],
    { stdio: 'inherit', env },
  );
  process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
