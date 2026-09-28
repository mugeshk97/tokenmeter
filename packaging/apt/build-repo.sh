#!/usr/bin/env bash
# Builds a signed apt repository (served from GitHub Pages) from .deb files.
#
#   packaging/apt/build-repo.sh <dir-with-debs> <output-dir>
#
# Needs dpkg-scanpackages, apt-ftparchive and a gpg secret key in the keyring (CI imports it from
# the APT_GPG_PRIVATE_KEY secret). Users add it with the commands on the landing page (site/, #linux).
set -euo pipefail

debs=${1:?dir with .deb files}
out=${2:?output dir}
here=$(cd "$(dirname "$0")" && pwd)
dist=stable
comp=main
arch=amd64

rm -rf "$out"
mkdir -p "$out/pool/$comp/t/tokenmeter" "$out/dists/$dist/$comp/binary-$arch"
cp "$debs"/*.deb "$out/pool/$comp/t/tokenmeter/"

cd "$out"
# No --arch: it filters on Debian-style file names (_amd64.deb); every .deb here is amd64 anyway.
dpkg-scanpackages --multiversion pool/ > "dists/$dist/$comp/binary-$arch/Packages"
[ -s "dists/$dist/$comp/binary-$arch/Packages" ] || { echo "no packages indexed" >&2; exit 1; }
gzip -9 -k "dists/$dist/$comp/binary-$arch/Packages"

apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=Tokenmeter \
  -o APT::FTPArchive::Release::Label=Tokenmeter \
  -o APT::FTPArchive::Release::Suite="$dist" \
  -o APT::FTPArchive::Release::Codename="$dist" \
  -o APT::FTPArchive::Release::Architectures="$arch" \
  -o APT::FTPArchive::Release::Components="$comp" \
  release "dists/$dist" > Release.tmp # written outside dists/, or it would list itself
mv Release.tmp "dists/$dist/Release"

gpg --batch --yes --clearsign -o "dists/$dist/InRelease" "dists/$dist/Release"
gpg --batch --yes --armor --detach-sign -o "dists/$dist/Release.gpg" "dists/$dist/Release"

# Public key, binary form for apt's signed-by=.
gpg --dearmor < "$here/tokenmeter-archive-keyring.asc" > tokenmeter-archive-keyring.gpg

version=$(dpkg-deb -f "$(ls pool/$comp/t/tokenmeter/*.deb | sort -V | tail -1)" Version)
echo "apt repo for ${version} in $out (install instructions live on the landing page, site/index.html)"
