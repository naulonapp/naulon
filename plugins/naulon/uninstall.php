<?php
/**
 * Uninstall.
 *
 * This file deliberately performs no deletion of its own. Everything it could destroy sits behind
 * one guarded call, because WordPress runs uninstall BEFORE it removes the plugin's files
 * (`wp-admin/includes/plugin.php`: `uninstall_plugin()`, then `$wp_filesystem->delete()`) — so a
 * Delete that visibly FAILS can still have wiped the data. That is not hypothetical: it happened
 * to a real site whose plugin directory was owned by root, where the file removal failed, the
 * plugin stayed listed as installed, and the wallets and the earnings table were already gone.
 *
 * Default: your data stays. Deleting the plugin removes our code, not your authors' wallets or
 * your record of what was paid. The opt-in for full removal lives on naulon → Diagnostics, next to
 * live counts of what it would destroy, with an export beside it.
 *
 * `Naulon_Data` carries the policy and the reasoning. `UninstallGuardTest` asserts this file stays
 * a delegation, so "nothing is destroyed unless the publisher asked in advance" is a property of
 * the code rather than a promise in a comment.
 *
 * @package naulon
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

if ( ! defined( 'NAULON_PLUGIN_DIR' ) ) {
	define( 'NAULON_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
}
if ( ! defined( 'NAULON_VERSION' ) ) {
	// Uninstall runs without the plugin bootstrapping, and the export payload records a version.
	define( 'NAULON_VERSION', 'uninstall' );
}

require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-settings.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-roles.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-credits.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-wallet.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-agent.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-ledger.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-log.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-cache.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-cron.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-data.php';

Naulon_Data::uninstall();
