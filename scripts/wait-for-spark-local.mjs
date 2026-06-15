#!/usr/bin/env node

import net from "node:net";

const ports = [8535, 8536, 8537];
const deadline = Date.now() + 180_000;

while (Date.now() < deadline) {
  const results = await Promise.all(ports.map(canConnect));
  if (results.every(Boolean)) {
    console.log("Spark local operators are accepting TCP connections");
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

console.error("Timed out waiting for Spark local operators");
process.exit(1);

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}
