## Setting it up (for the human; not part of the skill)

> These steps assume you have already set up reverser-progress-graph itself: `npm install && npm run build`, and a
> Python `.venv` with `venv-requirements.txt` installed (see its `README.md`). Commands below run from that checkout.

1. **Build a tree per input directory** (see `docs/README-DETAIL-GRAPH-BUILDER.md` in reverser-progress-graph):

   ```
   .venv/bin/python scripts/build_callgraph.py --game game-data/FIRST-GAME --out <project>/generated/first-game
   ```

   If a program reads code from a data file and far-calls it, declare it in `game-data/loaded_modules.json` (with a
   reader plugin for the container format) before building; otherwise those calls stay `unresolved (indirect)`.
2. **Lay out the project** so the server can check `Implements:` comments:

   ```
   <project>/
     generated/<tree>/                      the trees (keep them out of any public repository)
     reimplementation/progress/             <tree>.progress.json, one per tree, written by the server
     <implementation root>/src, include     your C++ (the server only accepts files under this root)
   ```
3. **Register one server per tree** in your MCP client's config, with absolute paths:

   ```json
   {
     "mcpServers": {
       "first-game-progress-graph": {
         "command": "node",
         "args": ["/path/to/reverser-progress-graph/build/index.js",
                  "--disassembly-root", "/path/to/<project>/generated/first-game",
                  "--progress-root", "/path/to/<project>/reimplementation/progress",
                  "--implementation-root", "/path/to/<project>/<implementation root>",
                  "--game-name", "<First game title>"]
       },
       "first-game-second-game-compare": {
         "command": "node",
         "args": ["/path/to/reverser-progress-graph/build/index.js",
                  "--disassembly-root", "/path/to/<project>/generated/first-game",
                  "--compare", "/path/to/<project>/generated/second-game",
                  "--progress-root", "/path/to/<project>/reimplementation/progress",
                  "--implementation-root", "/path/to/<project>/<implementation root>"]
       }
     }
   }
   ```

   Give compare servers their own entries so implementing agents never see the extra tools unless you load them.
4. **Watch progress** with `node /path/to/reverser-progress-graph/build/index.js --dashboard --disassembly-root …
   --progress-root …` (same roots as the stdio servers; it binds 127.0.0.1 and prints the URL).
5. **Fill in this skill**: the server table, your implementation root and build command, the compilers your
   programs were built with, and anything your project's conventions add.
