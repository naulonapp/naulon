<?php
/**
 * Parity harness: one Accept header per stdin line, the plugin's licence Content-Type per stdout
 * line. The control plane's `wp-rules-parity.test.ts` compares it with `rslContentType`.
 * Test-only; not shipped.
 *
 * @package naulon
 */

require __DIR__ . '/bootstrap.php';

while ( ( $line = fgets( STDIN ) ) !== false ) {
	echo Naulon_License::content_type( json_decode( $line, true ) ), "\n";
}
