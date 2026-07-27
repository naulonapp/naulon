<?php
/**
 * Uninstall — the only path that removes data.
 *
 * Deactivation deliberately keeps everything: a publisher who deactivates to debug a theme
 * conflict must not lose their authors' wallet addresses. Uninstall is the explicit "remove
 * this plugin and its data" action, so it removes the settings, the capabilities, and the
 * per-user wallets.
 *
 * Wallets are the sensitive part. Leaving them behind would strand payout addresses in a
 * database nobody is watching any more, which is worse than deleting them — an author can
 * always paste their address again.
 *
 * @package naulon
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

require_once plugin_dir_path( __FILE__ ) . 'includes/class-naulon-settings.php';
require_once plugin_dir_path( __FILE__ ) . 'includes/class-naulon-roles.php';
require_once plugin_dir_path( __FILE__ ) . 'includes/class-naulon-credits.php';

Naulon_Settings::delete_all();
Naulon_Roles::remove_capabilities();

delete_metadata( 'user', 0, Naulon_Credits::USER_WALLET_META, '', true );
delete_post_meta_by_key( Naulon_Credits::POST_TOLL_META );
