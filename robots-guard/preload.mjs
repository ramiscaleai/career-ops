// Load with `node --import ./robots-guard/preload.mjs <script>`: every fetch() in that
// process then obeys robots.txt (see robots-guard.mjs).
import { install } from './robots-guard.mjs';

install();
