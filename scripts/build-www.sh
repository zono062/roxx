#!/bin/sh
# iOSアプリに同梱するWeb資産だけを www/ に集める。
# リポジトリ直下には supabase/ や ios/ もあるため、丸ごとは入れない。
set -e
cd "$(dirname "$0")/.."
rm -rf www && mkdir -p www
cp index.html auth.js social.js notify.js push.js sw.js manifest.json hyrox_engine_v0.json www/
cp *.png www/
cp -R legal www/
echo "www/ に同梱ファイルを用意しました"
