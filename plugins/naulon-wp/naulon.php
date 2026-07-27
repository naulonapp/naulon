<?php
/**
 * Plugin Name:       naulon — citation toll for WordPress
 * Plugin URI:        https://naulon.app
 * Description:       Charge AI agents for reading your articles. Humans always read free. Pays your authors directly — no custody, no middleman wallet.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            naulon
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       naulon
 * Domain Path:       /languages
 *
 * The WordPress equivalent of the `@naulon/enforce` SDK. A Node site installs the SDK and
 * writes a credits route; a WordPress site cannot, so this plugin IS that surface: the credits
 * contract from real WP author data, wallet administration, ownership verification, and (from
 * S2 on) the local decision path.
 *
 * Licensing note: the rest of this monorepo is MIT. wordpress.org requires GPLv2-or-later, and
 * we hold the copyright, so this directory ships GPL-2.0-or-later. MIT is GPL-compatible, so
 * nothing here is in tension — it is a deliberate per-directory relicense of our own work.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

define( 'NAULON_VERSION', '0.1.0' );
define( 'NAULON_PLUGIN_FILE', __FILE__ );
define( 'NAULON_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );

/**
 * Plain requires, not an autoloader: wordpress.org review prefers boring, greppable includes,
 * and the file count here is small enough that lazy loading buys nothing measurable.
 */
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-slug.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-wallet.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-key.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-settings.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-client.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-challenge.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-verification.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-credits.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-roles.php';

/**
 * Wire the plugin. Everything is hook-registration only — no work happens at load time, so a
 * request that never touches a naulon surface pays nothing but the requires above.
 */
function naulon_bootstrap() {
	Naulon_Challenge::instance()->register();
	Naulon_Credits::instance()->register();
}
add_action( 'plugins_loaded', 'naulon_bootstrap' );

/**
 * Activation: grant the capabilities and add the rewrite rule, then flush ONCE. Flushing is
 * expensive and must never run on a normal request (a classic plugin sin) — activation and
 * deactivation are the only two places it is correct.
 */
function naulon_activate() {
	Naulon_Roles::add_capabilities();
	Naulon_Challenge::instance()->add_rewrite_rules();
	flush_rewrite_rules();
}
register_activation_hook( __FILE__, 'naulon_activate' );

/**
 * Deactivation drops the rewrite rule but KEEPS all data (wallets, settings, verification
 * state). A publisher who deactivates to debug something must not lose their author wallets;
 * only uninstall removes data.
 */
function naulon_deactivate() {
	flush_rewrite_rules();
}
register_deactivation_hook( __FILE__, 'naulon_deactivate' );
