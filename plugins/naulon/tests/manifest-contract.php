<?php
/**
 * The cross-language half of the update contract.
 *
 * The manifest is written by `scripts/wp-update-manifest.mjs` (JavaScript, in CI) and read by
 * `Naulon_Updater` (PHP, on a publisher's server). Nothing about that boundary is checked by
 * either side's own tests: the generator can assert its output is well-formed and the plugin can
 * assert it validates a hand-written array, and both can pass while the two disagree about a field
 * name. The failure that produces is silent — the plugin rejects every real manifest, which looks
 * exactly like "no update available" on every install.
 *
 * So CI generates a real manifest and feeds it to the real validator, here. No fixture: a
 * committed sample of a generated document is a second source of truth, which is the thing this
 * whole feature exists to remove.
 *
 * Plain PHP on purpose — no composer, no PHPUnit — so it runs on whatever PHP the job already has,
 * next to the generator that produced its input.
 *
 *   node scripts/wp-update-manifest.mjs --out=/tmp/m.json
 *   php plugins/naulon/tests/manifest-contract.php /tmp/m.json
 *
 * @package naulon
 */

define( 'ABSPATH', __DIR__ . '/' );
define( 'MINUTE_IN_SECONDS', 60 );
define( 'HOUR_IN_SECONDS', 3600 );

require_once __DIR__ . '/../includes/class-naulon-updater.php';

$path = isset( $argv[1] ) ? $argv[1] : '';
if ( '' === $path || ! is_readable( $path ) ) {
	fwrite( STDERR, "manifest-contract: usage: php manifest-contract.php <manifest.json>\n" );
	exit( 2 );
}

$manifest = json_decode( file_get_contents( $path ), true );
if ( ! is_array( $manifest ) ) {
	fwrite( STDERR, "manifest-contract: {$path} is not a JSON object\n" );
	exit( 1 );
}

$failures = array();

$validated = Naulon_Updater::validate( $manifest );
if ( null === $validated ) {
	$failures[] = 'the plugin REJECTS the manifest CI would publish — every site would see "no update available"';
	$validated  = $manifest; // Keep going: the checks below name which field is the reason.
}

// The version in the manifest has to be the version in the plugin the release ships. If it is not,
// WordPress offers an update whose zip contains something else.
$php     = file_get_contents( __DIR__ . '/../naulon.php' );
$matched = preg_match( '/^\s*\*\s*Version:\s*(\S+)/m', $php, $header );
if ( 1 !== $matched ) {
	$failures[] = 'no Version: header in naulon.php';
} elseif ( ( isset( $manifest['version'] ) ? $manifest['version'] : '' ) !== $header[1] ) {
	$failures[] = "manifest version {$manifest['version']} but the plugin header says {$header[1]}";
}

// The mappings must survive the real document, not just the test's array.
$payload = Naulon_Updater::payload( $validated, 'naulon/naulon.php', '9.9.9' );
foreach ( array( 'version', 'slug', 'plugin', 'package', 'url' ) as $key ) {
	if ( empty( $payload[ $key ] ) ) {
		$failures[] = "payload has no {$key} — core needs it to offer the update";
	}
}

$info = Naulon_Updater::information( $validated, '9.9.9' );
foreach ( array( 'name', 'version', 'download_link' ) as $key ) {
	if ( empty( $info[ $key ] ) ) {
		$failures[] = "plugin_information has no {$key} — the details modal would render blank";
	}
}
foreach ( array( 'description', 'changelog' ) as $key ) {
	if ( empty( $info['sections'][ $key ] ) ) {
		$failures[] = "plugin_information section '{$key}' is empty";
	}
}

if ( $failures ) {
	fwrite( STDERR, 'manifest-contract: ' . count( $failures ) . " problem(s)\n" );
	foreach ( $failures as $failure ) {
		fwrite( STDERR, "  - {$failure}\n" );
	}
	exit( 1 );
}

fwrite( STDERR, "manifest-contract: ok — the plugin accepts the manifest CI publishes ({$payload['version']})\n" );
