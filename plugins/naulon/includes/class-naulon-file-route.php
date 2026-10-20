<?php
/**
 * The rewrite rule that sends opted-in uploads to the file toll.
 *
 * WordPress's own `.htaccess` excludes an existing file from its rewrite, so Apache serves a PDF
 * without loading PHP and no plugin hook can see the request. This class owns one marker block in
 * that same file, written only through core `insert_with_markers()`, that rewrites the opted-in
 * types (and the self-test's probe directory) to `index.php?naulon_file=<path>`.
 *
 * The rule is guarded by `-f` on this plugin's own main file. If the plugin is deleted without its
 * deactivation hook running (removed over FTP, say), the condition fails and Apache serves files
 * exactly as stock WordPress does. A stale rule that broke the uploads directory would cost far
 * more than an untolled PDF, so the failure mode is chosen to be the harmless one.
 *
 * The block's position in the file does not matter: WordPress's rule only fires for paths that are
 * not files, so for an existing file Apache carries on to this one, and the rewritten request then
 * stops at WordPress's own `^index\.php$ - [L]`.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_File_Route {

	/** The marker name in `.htaccess`. */
	const MARKER = 'naulon-files';

	/** @var Naulon_File_Route|null */
	private static $instance = null;

	/**
	 * @return Naulon_File_Route
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Hook into WordPress: follow the opted-in set when it changes.
	 *
	 * @return void
	 */
	public function register() {
		add_action( 'naulon_file_types_changed', array( $this, 'sync' ), 10, 0 );
	}

	/**
	 * The lines of the marker block.
	 *
	 * @param string[] $types          Opted-in extensions.
	 * @param string   $plugin_file    Absolute path of this plugin's main file.
	 * @param string   $uploads_rel    Uploads URL path relative to the home path, e.g. `wp-content/uploads`.
	 * @param string   $home_path      Home URL path with trailing slash, e.g. `/` or `/blog/`.
	 * @return string[]
	 */
	public static function rules_for( array $types, $plugin_file, $uploads_rel, $home_path ) {
		return array(
			'<IfModule mod_rewrite.c>',
			'RewriteEngine On',
			'RewriteCond "' . $plugin_file . '" -f',
			'RewriteRule ^' . self::quote( trim( $uploads_rel, '/' ) ) . '/' . self::capture( $types ) . '$ ' . $home_path . 'index.php?' . Naulon_File_Toll::QUERY_VAR . '=$1 [L,QSA]',
			'</IfModule>',
		);
	}

	/**
	 * The nginx rule for a server that ignores `.htaccess`.
	 *
	 * @param string[] $types        Opted-in extensions.
	 * @param string   $uploads_path Uploads URL path, e.g. `/wp-content/uploads/`.
	 * @param string   $home_path    Home URL path with trailing slash.
	 * @return string
	 */
	public static function nginx_snippet( array $types, $uploads_path, $home_path ) {
		return implode(
			"\n",
			array(
				'# naulon: send these uploads to WordPress so agents are tolled. People still download free.',
				'# Remove this block if you remove the naulon plugin, or these files stop loading.',
				'location ~* ^/' . self::quote( trim( $uploads_path, '/' ) ) . '/' . self::capture( $types ) . '$ {',
				'    try_files /nonexistent ' . $home_path . 'index.php?' . Naulon_File_Toll::QUERY_VAR . '=$1&$args;',
				'}',
			)
		);
	}

	/**
	 * The capture group: the probe directory, plus the opted-in extensions when there are any.
	 *
	 * @param string[] $types Opted-in extensions.
	 * @return string
	 */
	private static function capture( array $types ) {
		$types = array_values( array_intersect( Naulon_Rules::TOLLABLE_FILE_TYPES, $types ) );
		$probe = self::quote( Naulon_File_Probe::DIR ) . '/.+';
		return empty( $types ) ? '(' . $probe . ')' : '(' . $probe . '|.+\.(' . implode( '|', $types ) . '))';
	}

	/**
	 * Regex-quote a path for Apache and nginx. A hyphen and a slash are literal outside a class,
	 * so they stay readable rather than escaped.
	 *
	 * @param string $path A path.
	 * @return string
	 */
	private static function quote( $path ) {
		return str_replace( array( '\-', '\/' ), array( '-', '/' ), preg_quote( $path, '#' ) );
	}

	/**
	 * The uploads URL path relative to the home path, or null when uploads are served from another
	 * host or outside this site (a media-offload plugin, a CDN base URL).
	 *
	 * @return string|null
	 */
	public static function uploads_rel() {
		$uploads = wp_parse_url( wp_upload_dir( null, false )['baseurl'] );
		$home    = wp_parse_url( home_url( '/' ) );
		if ( ! is_array( $uploads ) || ! is_array( $home ) || ! isset( $uploads['host'], $home['host'] ) || strtolower( $uploads['host'] ) !== strtolower( $home['host'] ) ) {
			return null;
		}
		$home_path    = self::home_path();
		$uploads_path = isset( $uploads['path'] ) ? trailingslashit( $uploads['path'] ) : '/';
		if ( 0 !== strpos( $uploads_path, $home_path ) ) {
			return null;
		}
		return trim( substr( $uploads_path, strlen( $home_path ) ), '/' );
	}

	/**
	 * The home URL path, with a trailing slash.
	 *
	 * @return string
	 */
	public static function home_path() {
		$path = wp_parse_url( home_url( '/' ), PHP_URL_PATH );
		return trailingslashit( is_string( $path ) ? $path : '/' );
	}

	/**
	 * The uploads URL path, with slashes, for the nginx rule.
	 *
	 * @return string
	 */
	public static function uploads_path() {
		$path = wp_parse_url( wp_upload_dir( null, false )['baseurl'], PHP_URL_PATH );
		return trailingslashit( is_string( $path ) ? $path : '/wp-content/uploads' );
	}

	/**
	 * Write the marker block for the current opted-in set.
	 *
	 * @return bool False when the block could not be written: no mod_rewrite, an unwritable file,
	 *              multisite, or uploads served from elsewhere.
	 */
	public function sync() {
		if ( is_multisite() ) {
			return false;
		}
		$rel = self::uploads_rel();
		if ( null === $rel || '' === $rel ) {
			return false;
		}
		self::load_admin_helpers();
		if ( ! got_mod_rewrite() ) {
			return false;
		}
		return (bool) insert_with_markers(
			self::htaccess_path(),
			self::MARKER,
			self::rules_for( Naulon_Rules::instance()->file_types(), NAULON_PLUGIN_FILE, $rel, self::home_path() )
		);
	}

	/**
	 * Remove the marker block. Called on deactivation and uninstall.
	 *
	 * @return void
	 */
	public function remove() {
		self::load_admin_helpers();
		$path = self::htaccess_path();
		if ( file_exists( $path ) ) {
			insert_with_markers( $path, self::MARKER, array() );
		}
	}

	/**
	 * The block as it stands in `.htaccess`, for Diagnostics to show.
	 *
	 * @return string[]
	 */
	public function current() {
		self::load_admin_helpers();
		$lines = extract_from_markers( self::htaccess_path(), self::MARKER );
		return is_array( $lines ) ? $lines : array();
	}

	/**
	 * The lines a publisher would add by hand when WordPress cannot write the file.
	 *
	 * @return string[]
	 */
	public function wanted() {
		$rel = self::uploads_rel();
		return null === $rel ? array() : self::rules_for( Naulon_Rules::instance()->file_types(), NAULON_PLUGIN_FILE, $rel, self::home_path() );
	}

	/**
	 * @return string
	 */
	private static function htaccess_path() {
		return get_home_path() . '.htaccess';
	}

	/**
	 * `insert_with_markers()`, `got_mod_rewrite()` and `get_home_path()` live in admin includes,
	 * which cron and front-end requests do not load.
	 *
	 * @return void
	 */
	private static function load_admin_helpers() {
		if ( ! function_exists( 'insert_with_markers' ) || ! function_exists( 'got_mod_rewrite' ) ) {
			require_once ABSPATH . 'wp-admin/includes/misc.php';
		}
		if ( ! function_exists( 'get_home_path' ) ) {
			require_once ABSPATH . 'wp-admin/includes/file.php';
		}
	}
}
