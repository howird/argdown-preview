default: build

# Bundle the language server and the viewer into dist/
build:
    npm run build

# Rebuild dist/ on every source change
watch:
    npm run watch

test:
    npm test

typecheck:
    npm run typecheck

# Build the nix package and run the tests in the sandbox
check:
    nix flake check

# Update npmDepsHash in flake.nix after package-lock.json changes
hash:
    #!/usr/bin/env bash
    set -euo pipefail
    hash=$(nix run nixpkgs#prefetch-npm-deps -- package-lock.json)
    sed -i "s|npmDepsHash = \".*\";|npmDepsHash = \"$hash\";|" flake.nix
    echo "npmDepsHash = $hash"
