import { spawn } from 'child_process';

function startProcess(name, command, args, delay = 3000) {
  console.log(`[start.js] Starting ${name}: ${command} ${args.join(' ')}`);

  const proc = spawn(command, args, {
    stdio: 'inherit',
    env: process.env,
  });

  proc.on('error', (err) => {
    console.error(`[start.js] ${name} error:`, err);
  });

  proc.on('exit', (code, signal) => {
    const nextDelay = Math.min(delay * 2, 60000); // max 60s
    console.error(`[start.js] ${name} exited with code=${code} signal=${signal}. Restarting in ${nextDelay / 1000}s...`);
    setTimeout(() => startProcess(name, command, args, nextDelay), nextDelay);
  });

  return proc;
}

// Start Express HTTP server
startProcess('Express Server', 'node', ['server.js']);

// Start LiveKit Agent worker
// 'dev' arg connects in development mode — remove for production
startProcess('LiveKit Agent', 'node', ['agent.js', 'dev']);