{
  description = "Development shell for Spark unilateral exit recovery tooling";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.cargo
              pkgs.clippy
              pkgs.nodejs_22
              pkgs.rustc
              pkgs.rustfmt
            ];

            nativeBuildInputs = [
              pkgs.pkg-config
              pkgs.protobuf
            ];

            buildInputs = [
              pkgs.cacert
              pkgs.openssl
            ];

            PROTOC = "${pkgs.protobuf}/bin/protoc";
            SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";

            shellHook = ''
              export CARGO_TARGET_DIR="''${CARGO_TARGET_DIR:-$PWD/.cargo-target}"
            '';
          };
        }
      );
    };
}
