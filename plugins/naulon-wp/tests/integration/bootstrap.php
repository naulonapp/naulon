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
	// Nor does it create the earnings table. dbDelta here, once, before any test transaction.
	Naulon_Ledger::install();

	// The plugin loads its admin classes only when is_admin() is true, which it is not under
	// PHPUnit. They are plain classes with no side effects at load time, so requiring them here
	// lets the suite drive the screens' capability checks and save handlers directly.
	$naulon_dir = dirname( __DIR__, 2 ) . '/includes/';
	require_once $naulon_dir . 'class-naulon-admin.php';
	require_once $naulon_dir . 'admin/class-naulon-admin-setup.php';
	require_once $naulon_dir . 'admin/class-naulon-admin-content.php';
	require_once $naulon_dir . 'admin/class-naulon-admin-people.php';
	require_once $naulon_dir . 'admin/class-naulon-admin-earnings.php';
	require_once $naulon_dir . 'admin/class-naulon-admin-diagnostics.php';
}
tests_add_filter( 'muplugins_loaded', 'naulon_manually_load_plugin' );

require $naulon_tests_dir . '/includes/bootstrap.php';
