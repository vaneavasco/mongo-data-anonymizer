#!/usr/bin/env node
import { main } from './main';

main().catch((error) => {console.log(error.message)});
