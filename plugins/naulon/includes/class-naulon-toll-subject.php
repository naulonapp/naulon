<?php
/**
 * The thing a toll decision is about: an article, or a file in the media library.
 *
 * The decision path in Naulon_Enforcer asks four questions of what was requested: is it sold, who
 * is credited, which slug the control plane prices, and which URL the licence names. An article
 * answers all four from its post. A file answers the first two from the post it belongs to and the
 * last two from its own URL. Carrying those answers here is what lets one decision path serve both,
 * so a file can never be decided by a second copy of the toll.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

final class Naulon_Toll_Subject {

	/** @var string article|file */
	public $kind;

	/** @var WP_Post The post whose verdict and contributors apply. For a file, its parent post or itself. */
	public $owner;

	/** @var array|null For a file, Naulon_Credits::resolve_file()'s result. */
	public $file;

	/** @var string Canonical slug the control plane prices. */
	public $slug;

	/** @var string Absolute URL the licence names. */
	public $resource;

	/**
	 * @param string     $kind     article|file.
	 * @param WP_Post    $owner    The post whose verdict applies.
	 * @param array|null $file     The resolved file, or null.
	 * @param string     $slug     Canonical slug.
	 * @param string     $resource Absolute URL.
	 */
	private function __construct( $kind, $owner, $file, $slug, $resource ) {
		$this->kind     = $kind;
		$this->owner    = $owner;
		$this->file     = $file;
		$this->slug     = $slug;
		$this->resource = $resource;
	}

	/**
	 * @param WP_Post $post The article.
	 * @return Naulon_Toll_Subject
	 */
	public static function for_post( $post ) {
		$permalink = get_permalink( $post );
		return new self( 'article', $post, null, Naulon_Credits::instance()->canonical_slug_for( $post ), is_string( $permalink ) ? $permalink : '' );
	}

	/**
	 * @param array $file Naulon_Credits::resolve_file()'s result.
	 * @return Naulon_Toll_Subject
	 */
	public static function for_file( array $file ) {
		$url = wp_get_attachment_url( $file['attachment']->ID );
		return new self( 'file', $file['owner'], $file, Naulon_Credits::instance()->canonical_slug_for_file( $file['attachment'] ), is_string( $url ) ? $url : '' );
	}

	/**
	 * Is this sold at all? Same verdict the credits endpoint gives.
	 *
	 * @return bool
	 */
	public function is_tollable() {
		$credits = Naulon_Credits::instance();
		return 'file' === $this->kind ? $credits->file_is_tollable( $this->file ) : $credits->is_tollable( $this->owner );
	}
}
