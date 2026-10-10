// Lance Electron en nettoyant l'environnement.
// VSCode et les terminaux intégrés Electron exportent ELECTRON_RUN_AS_NODE=1 ;
// hérité par npm, il fait démarrer notre binaire comme un simple Node
// (« Cannot read properties of undefined (reading 'getAppPath') »).
import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('close', (code) => process.exit(code ?? 0));
