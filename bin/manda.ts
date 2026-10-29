#!/usr/bin/env bun
import { main } from "../src/cli";

process.exit(main(process.argv.slice(2)));
