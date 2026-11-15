// This entrypoint turns a sealed snapshot into the board, dashboard data, and dossier.
// The model scores pre-token protocols against the snapshot's own live comparables.
// The dashboard is static and reads the data script written here.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boardIssue,
  buildRadar,
  dataScript,
  parseSnapshot,
} from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(
  new URL('.', import.meta.url),
);

// These limits match the scorer's expected dossier inputs.
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = {
  max: 4,
  max_bytes: 524_288,
};
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read --name value or --name=value, returning the fallback when absent. */
function arg(
  name: string,
  fallback: string,
): string {
  const flag = `--${name}`;
  const at = process.argv.indexOf(flag);

  if (at >= 0 && at + 1 < process.argv.length) {
    return process.argv[at + 1]!;
  }

  const equalsFlag = `--${name}=`;
  const withEquals = process.argv.find((value) => value.startsWith(equalsFlag));

  if (withEquals === undefined) {
    return fallback;
  }

  return withEquals.slice(equalsFlag.length);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json')
  ? inputArg
  : join(inputArg, 'snapshot.json');

if (!existsSync(inputFile)) {
  process.stderr.write(
    `token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`,
  );
  process.exit(2);
}

const out = arg(
  'output',
  process.env.MAKEFUN_OUTPUT_DIR ?? '/output',
);

// Parse once, then use the same snapshot for scoring and the self-check.
const snapshotText = readFileSync(inputFile, 'utf8');
const snapshot = parseSnapshot(snapshotText);
const result = buildRadar(snapshot);
const board = result.board;
const radar = result.radar;
const issue = boardIssue(board, snapshot);

if (issue !== null) {
  process.stderr.write(
    `token radar: the model wrote a board the gate refuses: ${issue}\n`,
  );
  process.exit(1);
}

// Create the destination before writing the primary board and its data script.
mkdirSync(out, {
  recursive: true,
});
writeFileSync(
  join(out, 'board.json'),
  `${JSON.stringify({ rows: board })}\n`,
);
writeFileSync(
  join(out, 'data.js'),
  dataScript(radar),
);

/** Copy regular, non-hidden files from one directory into another. */
function copyFiles(
  from: string,
  to: string,
): string[] {
  if (!existsSync(from)) {
    return [];
  }

  mkdirSync(to, {
    recursive: true,
  });
  const copied: string[] = [];

  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) {
      continue;
    }

    const sourcePath = join(from, name);

    if (!statSync(sourcePath).isFile()) {
      continue;
    }

    const destinationPath = join(to, name);
    copyFileSync(sourcePath, destinationPath);
    copied.push(name);
  }

  return copied;
}

// Copy the static page and its available screenshots into the output tree.
copyFiles(
  join(here, 'dashboard'),
  join(out, 'dashboard'),
);
const shots = copyFiles(
  join(here, 'screenshots'),
  join(out, 'screenshots'),
);

if (shots.length < 3) {
  const imageNoun = shots.length === 1
    ? 'image'
    : 'images';
  process.stderr.write(
    `token radar: screenshots/ holds ${shots.length} ${imageNoun}: hand in 3, the board, a detail view and a filtered view\n`,
  );
  process.exit(1);
}

for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(
      `token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`,
    );
    process.exit(1);
  }
}

// Write this final artifact after every input it summarizes has been copied.
// The dossier captures the output tree's contents and the limits used to admit
// those files, so build it only after the dashboard and screenshot pass.
const dossierCaps = {
  text_max_bytes: TEXT_MAX_BYTES,
  screenshots: SCREENSHOT_CAPS,
  dashboard: {
    max_files: 400,
    max_bytes: 4_194_304,
  },
};

// Keep the same cap object for the builder and persist its serialized result
// beside the board artifacts as the last output from this invocation.
const dossier = buildDossier(out, dossierCaps);
writeFileSync(
  join(out, 'dossier.json'),
  dossier,
);

// Report snapshot coverage and the files produced by this invocation.
const scoredSummary =
  `token radar: ${snapshot.protocols.length} protocols, ` +
  `${snapshot.watchlist.length} on the watchlist, ` +
  `${board.length} rows scored (${radar.early_size} early, ` +
  `${radar.live_size} live set aside)\n`;
const writtenSummary =
  `token radar: wrote ${join(out, 'board.json')}, ` +
  `${join(out, 'data.js')}, ` +
  `${join(out, 'dashboard')} (3 files), ` +
  `${join(out, 'screenshots')} (${shots.length} images) and ` +
  `${join(out, 'dossier.json')}\n`;
process.stdout.write(scoredSummary + writtenSummary);
