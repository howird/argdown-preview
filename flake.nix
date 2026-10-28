{
  description = "Live Argdown argument-map preview in your browser, driven by a language server for Helix";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    packages = forAllSystems (pkgs: rec {
      default = argdown-preview;

      # The preview language server, plus the argdown CLI and language server it pins. `port` runs
      # ss, so iproute2 goes on PATH where it exists.
      argdown-preview = pkgs.buildNpmPackage {
        pname = "argdown-preview";
        version = "0.1.0";
        src = self;
        nodejs = pkgs.nodejs_22;
        npmDepsHash = "sha256-qzuuI1Z7G7YJPDtfrkBRvX7LlaV1dk04LKsudBtfnR4=";

        doCheck = true;
        nativeCheckInputs = pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.iproute2;
        checkPhase = ''
          runHook preCheck
          npm test
          runHook postCheck
        '';

        postInstall = let
          modules = "$out/lib/node_modules/argdown-preview/node_modules/@argdown";
        in ''
          wrapProgram $out/bin/argdown-preview \
            --prefix PATH : ${pkgs.lib.makeBinPath (pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.iproute2)}
          makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/argdown \
            --add-flags ${modules}/cli/dist/cli.js
          makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/argdown-language-server \
            --add-flags ${modules}/language-server/dist/server.node.js
        '';

        nativeBuildInputs = [pkgs.makeWrapper];
        meta.mainProgram = "argdown-preview";
      };
    });

    apps = forAllSystems (pkgs: let
      app = name: {
        type = "app";
        program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.argdown-preview}/bin/${name}";
      };
    in rec {
      default = argdown-preview;
      argdown-preview = app "argdown-preview";
      argdown = app "argdown";
      argdown-language-server = app "argdown-language-server";
    });

    # The shell for writing Argdown: the preview, the argdown CLI and its language server.
    devShells = forAllSystems (pkgs: {
      default = pkgs.mkShell {
        nativeBuildInputs = [
          self.packages.${pkgs.stdenv.hostPlatform.system}.argdown-preview
          pkgs.just
          pkgs.watchexec
        ];
      };

      # The shell for working on argdown-preview itself.
      develop = pkgs.mkShell {
        nativeBuildInputs = [pkgs.nodejs_22 pkgs.just] ++ pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.iproute2;
      };
    });

    checks = forAllSystems (pkgs: {
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.argdown-preview;
    });

    formatter = forAllSystems (pkgs: pkgs.alejandra);
  };
}
