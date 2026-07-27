<?php
/**
 * Integration bootstrap — the real WordPress test framework, provided by wp-env at
 * /wordpress-phpunit. These tests exercise posts, users, meta, roles and the REST route as
 * WordPress actually implements them.
 *
 * The unit suite (tests/unit) covers the money-routing primitives with no WordPress at all and
 * runs in milliseconds; this suite covers everything that only exists once WordPress does.
 *
 * @package naulon
 */

$naulon_tests_dir = getenv( 'WP_TESTS_DIR' );
if ( ! $naulon_tests_dir ) {
	$naulon_tests_dir = '/wordpress-phpunit';
}

require_once $naulon_tests_dir . '/includes/functions.php';

/**
 * Load the plugin into the test WordPress before it boots.
 */
function naulon_manually_load_plugin() {
	require dirname( __DIR__, 2 ) . '/naulon.php';
	// Activation normally grants these; the test WordPress never runs the activation hook.
	Naulon_Roles::add_capabilities();
}
tests_add_filter( 'muplugins_loaded', 'naulon_manually_load_plugin' );

require $naulon_tests_dir . '/includes/bootstrap.php';
