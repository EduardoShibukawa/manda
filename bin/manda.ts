#!/usr/bin/env bun
import { run } from "../src/cli";

process.exit(run(process.argv.slice(2)));
