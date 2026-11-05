#!/usr/bin/env bash
# A real WordPress with this plugin mounted, left running for a browser walk.
#
#   bin/walk.sh up       # WordPress + MySQL on http://localhost:${PORT:-8081}, admin a / a
#   bin/walk.sh seed     # an author with a wallet and two posts, so the screens have rows
#   bin/walk.sh down     # remove the containers, the network and the volume
#
# The plugin directory is bind-mounted, so an edit to PHP or CSS shows on the next reload. Set
# NAULON_BASE to a fleet the container can reach (for a local one,
# http://host.docker.internal:11200) and it is stored as the hosted gate, which is what Connect
# talks to. route-check.sh proves the file route and removes everything it starts; this one
# exists so a person can look at the screens.
set -euo pipefail
CMD=${1:-up}
HERE=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-8081}
P=naulon-walk
NET=$P-net
WPENV="-e WORDPRESS_DB_HOST=$P-db -e WORDPRESS_DB_USER=root -e WORDPRESS_DB_PASSWORD=root -e WORDPRESS_DB_NAME=wp"
# :z relabels the mount for SELinux hosts (Fedora); without it Apache gets EACCES on every plugin
# file and WordPress reports the plugin as missing. Docker ignores it elsewhere.
MOUNT="-v $HERE:/var/www/html/wp-content/plugins/naulon:z"
CLI="docker run --rm --network $NET $WPENV -v $P-html:/var/www/html $MOUNT -u 33:33 wordpress:cli"

down() {
  docker rm -f $P-db $P-wp >/dev/null 2>&1 || true
  docker network rm $NET >/dev/null 2>&1 || true
  docker volume rm $P-html >/dev/null 2>&1 || true
}

case "$CMD" in
  down)
    down
    echo "removed"
    ;;
  up)
    if ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q .; then
      echo "port $PORT is held; set PORT= or run bin/walk.sh down if it is an old walk" >&2
      exit 1
    fi
    down
    docker network create $NET >/dev/null
    docker run -d --name $P-db --network $NET -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=wp mysql:8.0 >/dev/null
    docker run -d --name $P-wp --network $NET -p "127.0.0.1:$PORT:80" \
      --add-host host.docker.internal:host-gateway $WPENV -v $P-html:/var/www/html $MOUNT \
      wordpress:php8.3-apache >/dev/null
    for _ in $(seq 90); do docker exec $P-db mysql -uroot -proot -e "select 1" wp >/dev/null 2>&1 && break; sleep 2; done
    for _ in $(seq 60); do docker exec $P-wp test -f /var/www/html/wp-config.php && break; sleep 1; done
    $CLI wp core install --url="http://localhost:$PORT" --title="Walk" --admin_user=a --admin_password=a \
      --admin_email=a@example.com --skip-email >/dev/null
    $CLI wp rewrite structure '/%postname%/' >/dev/null
    $CLI wp plugin activate naulon >/dev/null
    if [ -n "${NAULON_BASE:-}" ]; then
      $CLI wp eval "Naulon_Settings::update( array( 'api_base' => '$NAULON_BASE' ) );" >/dev/null
    fi
    echo "http://localhost:$PORT/wp-admin/admin.php?page=naulon  (a / a)"
    ;;
  seed)
    $CLI wp eval '
      $u = wp_insert_user( array( "user_login" => "w", "user_pass" => "w", "role" => "author", "display_name" => "Ada Writer" ) );
      update_user_meta( $u, Naulon_Credits::USER_WALLET_META, "0x1111111111111111111111111111111111111111" );
      foreach ( array( "The paper", "A second piece" ) as $t ) {
        wp_insert_post( array( "post_title" => $t, "post_status" => "publish", "post_author" => $u, "post_content" => str_repeat( "Words. ", 200 ) ) );
      }
      echo "seeded\n";
    '
    ;;
  *)
    echo "usage: bin/walk.sh up|seed|down" >&2
    exit 2
    ;;
esac
