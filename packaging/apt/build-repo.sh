#!/usr/bin/env bash
# Builds a signed apt repository (served from GitHub Pages) from .deb files.
#
#   packaging/apt/build-repo.sh <dir-with-debs> <output-dir>
#
# Needs dpkg-scanpackages, apt-ftparchive and a gpg secret key in the keyring (CI imports it from
# the APT_GPG_PRIVATE_KEY secret). Users add it with the commands in the generated index.html.
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
cat > index.html <<EOF
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tokenmeter apt repository</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px}pre{background:#f4f5f8;padding:12px;border-radius:8px;overflow:auto}</style>
<h1>Tokenmeter apt repository</h1>
<p>Latest: ${version}. Install on Debian or Ubuntu (amd64); updates then arrive with your other system updates.</p>
<pre>curl -fsSL https://mugeshk97.github.io/tokenmeter/tokenmeter-archive-keyring.gpg | sudo tee /usr/share/keyrings/tokenmeter-archive-keyring.gpg &gt;/dev/null
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/tokenmeter-archive-keyring.gpg] https://mugeshk97.github.io/tokenmeter ${dist} ${comp}" | sudo tee /etc/apt/sources.list.d/tokenmeter.list
sudo apt update &amp;&amp; sudo apt install tokenmeter</pre>
<p>Other downloads: <a href="https://github.com/mugeshk97/tokenmeter/releases/latest">GitHub releases</a>.</p>
</html>
EOF
echo "apt repo for ${version} in $out"
