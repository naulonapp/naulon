#!/usr/bin/env bash
# Prove the file route on a real server, end to end: real WordPress, real .htaccess or nginx
# config, a stub control plane, and curl as a crawler and as a person.
#
#   bin/route-check.sh apache   # the plugin writes .htaccess itself
#   bin/route-check.sh nginx    # the server carries the snippet Diagnostics prints
#
# Needs docker. Leaves nothing behind.
set -euo pipefail
MODE=${1:-apache}
HERE=$(cd "$(dirname "$0")/.." && pwd)
P=naulon-rc-$MODE
NET=$P-net
cleanup() { docker rm -f $P-db $P-stub $P-wp $P-fpm $P-nginx >/dev/null 2>&1 || true; docker network rm $NET >/dev/null 2>&1 || true; docker volume rm $P-html >/dev/null 2>&1 || true; }
[ "${KEEP:-}" = 1 ] || trap cleanup EXIT
cleanup
docker network create $NET >/dev/null
docker run -d --name $P-db --network $NET -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=wp mysql:8.0 >/dev/null
docker run -d --name $P-stub --network $NET --network-alias stub -v "$HERE/bin/route-check/stub.php:/stub.php:ro" php:8.3-cli php -S 0.0.0.0:80 /stub.php >/dev/null
WPENV="-e WORDPRESS_DB_HOST=$P-db -e WORDPRESS_DB_USER=root -e WORDPRESS_DB_PASSWORD=root -e WORDPRESS_DB_NAME=wp"
if [ "$MODE" = apache ]; then
  docker run -d --name $P-wp --network $NET --network-alias wp $WPENV -v $P-html:/var/www/html -v "$HERE:/var/www/html/wp-content/plugins/naulon" wordpress:php8.3-apache >/dev/null
  WEB=$P-wp
else
  docker run -d --name $P-fpm --network $NET --network-alias wp-fpm $WPENV -v $P-html:/var/www/html -v "$HERE:/var/www/html/wp-content/plugins/naulon" wordpress:php8.3-fpm >/dev/null
  WEB=$P-fpm
fi
for i in $(seq 90); do docker exec $P-db mysql -uroot -proot -e "select 1" wp >/dev/null 2>&1 && break; sleep 2; done
for i in $(seq 60); do docker exec $WEB test -f /var/www/html/wp-config.php && break; sleep 1; done
CLI="docker run --rm --network $NET $WPENV -v $P-html:/var/www/html -v $HERE:/var/www/html/wp-content/plugins/naulon -u 33:33 wordpress:cli"
$CLI wp core install --url=http://wp --title=rc --admin_user=a --admin_password=a --admin_email=a@example.com --skip-email >/dev/null
$CLI wp rewrite structure '/%postname%/' >/dev/null
$CLI wp plugin activate naulon >/dev/null
if [ "$MODE" = nginx ]; then
  SNIPPET=$($CLI wp eval 'echo Naulon_File_Route::nginx_snippet( array( "pdf" ), Naulon_File_Route::uploads_path(), Naulon_File_Route::home_path() );')
fi
$CLI wp eval '
  Naulon_Settings::update( array( "api_key" => "nln_live_" . str_repeat( "a", 40 ), "api_base" => "http://stub", "verified_at" => gmdate( "c" ), "enforcement_on" => true ) );
  Naulon_Rules::instance()->refresh();
  // WP-CLI runs outside Apache, so got_mod_rewrite() is false here; a web request (the admin page,
  // the setup ping, wp-cron) decides it inside the server. Answer it the way that request would.
  add_filter( "got_rewrite", "__return_true" );
  Naulon_File_Route::instance()->sync();
  $u = wp_insert_user( array( "user_login" => "w", "user_pass" => "w", "role" => "author" ) );
  update_user_meta( $u, Naulon_Credits::USER_WALLET_META, "0x1111111111111111111111111111111111111111" );
  $p = wp_insert_post( array( "post_title" => "The paper", "post_name" => "the-paper", "post_status" => "publish", "post_author" => $u ) );
  $dir = wp_upload_dir(); wp_mkdir_p( $dir["path"] );
  file_put_contents( $dir["path"] . "/stage-toll.pdf", "%PDF-1.4\n% route check\n%%EOF\n" );
  $a = wp_insert_attachment( array( "post_mime_type" => "application/pdf", "post_title" => "Stage toll", "post_status" => "inherit", "post_author" => $u ), $dir["path"] . "/stage-toll.pdf", $p );
  echo wp_get_attachment_url( $a );
' > /tmp/$P-url
if [ "$MODE" = nginx ]; then
  printf '%s\n' "$SNIPPET" > /tmp/$P-snippet
  sed -e "/__SNIPPET__/r /tmp/$P-snippet" -e '/__SNIPPET__/d' "$HERE/bin/route-check/nginx.conf.tpl" > /tmp/$P-nginx.conf
  docker run -d --name $P-nginx --network $NET --network-alias wp -v $P-html:/var/www/html -v "$HERE:/var/www/html/wp-content/plugins/naulon:ro" -v /tmp/$P-nginx.conf:/etc/nginx/conf.d/default.conf:ro,Z nginx:1.27-alpine >/dev/null
  sleep 2
fi
URL=$(cat /tmp/$P-url)
CURL="docker run --rm --network $NET curlimages/curl:8.10.1 -s -o /dev/null -w %{http_code}"
CHROME='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'
fail=0
check() { local want=$1 got=$2 what=$3; if [ "$want" = "$got" ]; then echo "ok   $what ($got)"; else echo "FAIL $what: want $want, got $got"; fail=1; fi; }
check 402 "$($CURL -A GPTBot/1.0 "$URL")" "crawler is asked to pay for the PDF"
check 200 "$($CURL -A "$CHROME" -H 'Accept: text/html' "$URL")" "person downloads the PDF"
check 206 "$($CURL -A "$CHROME" -H 'Range: bytes=0-4' "$URL")" "person's PDF viewer gets a byte range"
CC=$(docker run --rm --network $NET curlimages/curl:8.10.1 -s -D - -o /dev/null -A "$CHROME" "$URL" | tr -d '\r' | grep -i '^cache-control:' | cut -d' ' -f2-)
check "private, no-store" "$CC" "file is never cached"
PROBE=$($CLI wp eval '$r = Naulon_File_Probe::instance()->run_and_report(); echo $r["status"];')
check ok "$PROBE" "self-test"
REPORTED=$(docker run --rm --network $NET curlimages/curl:8.10.1 -s http://stub/_naulon/reports | tail -1)
case "$REPORTED" in ok\;\ types=pdf\;\ at=*) echo "ok   the control plane heard: $REPORTED";; *) echo "FAIL report: $REPORTED"; fail=1;; esac
if [ "$MODE" = apache ]; then
  docker exec $P-wp sh -c 'f=/var/www/html/.htaccess; awk "/# BEGIN naulon-files/,/# END naulon-files/" $f > /tmp/b; grep -v -e "naulon" -e "RewriteCond \"/" $f > /tmp/rest; { cat /tmp/b; awk "!/^# (BEGIN|END) naulon-files/ && !/naulon_file/ && !/naulon.php/" $f; } > /tmp/moved; cp /tmp/moved $f'
  check 402 "$($CURL -A GPTBot/1.0 "$URL")" "block placed before WordPress's still routes"
  docker exec $P-wp mv /var/www/html/wp-content/plugins/naulon /var/www/html/wp-content/plugins/naulon-gone 2>/dev/null || docker exec -u 0 $P-wp sh -c 'mkdir -p /tmp/x'
  # The plugin directory is a bind mount and cannot be renamed in place, so point the guard at a
  # missing file instead: the same condition Apache sees once the plugin is gone.
  docker exec -u 0 $P-wp sed -i 's#plugins/naulon/naulon.php#plugins/naulon-gone/naulon.php#' /var/www/html/.htaccess
  check 200 "$($CURL -A GPTBot/1.0 "$URL")" "plugin removed by hand: Apache serves the file, nothing breaks"
  $CLI wp plugin deactivate naulon >/dev/null
  LEFT=$(docker exec $P-wp grep -c naulon_file /var/www/html/.htaccess || true)
  check 0 "$LEFT" "deactivation removes the rule"
fi
if [ "$MODE" = nginx ]; then
  # The same server without the snippet: files bypass PHP, and the self-test must say so.
  sed -e '/__SNIPPET__/d' "$HERE/bin/route-check/nginx.conf.tpl" > /tmp/$P-nginx.conf
  docker exec $P-nginx nginx -s reload
  sleep 1
  check 200 "$($CURL -A GPTBot/1.0 "$URL")" "without the snippet the crawler is served free"
  PROBE=$($CLI wp eval '$r = Naulon_File_Probe::instance()->run(); echo $r["status"];')
  check no_rewrite "$PROBE" "and the self-test reports it"
fi
exit $fail
