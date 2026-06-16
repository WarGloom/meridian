{
  description = "Meridian – Local Anthropic API powered by your Claude Max subscription";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
    bun2nix = {
      url = "github:nix-community/bun2nix/2.0.8";
      inputs = {
        nixpkgs.follows = "nixpkgs";
        systems.follows = "systems";
        flake-parts.follows = "flake-parts";
      };
    };
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{
      self,
      nixpkgs,
      systems,
      bun2nix,
      flake-parts,
    }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = import systems;

      perSystem =
        {
          config,
          pkgs,
          system,
          ...
        }:
        {
          _module.args.pkgs = import nixpkgs {
            inherit system;
            overlays = [ bun2nix.overlays.default ];
          };

          packages = {
            default = config.packages.meridian;
            meridian = pkgs.callPackage ./nix/package.nix { };
          };
        };

      flake = {
        overlays.default = final: _: {
          inherit (self.packages.${final.stdenv.hostPlatform.system}) meridian;
        };

        homeManagerModules.default = import ./nix/hm-module.nix { meridianPackages = self.packages; };
      };
    };
}
