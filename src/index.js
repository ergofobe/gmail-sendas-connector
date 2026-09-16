#!/usr/bin/env node
import { startServer } from "./server.js";

startServer({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
