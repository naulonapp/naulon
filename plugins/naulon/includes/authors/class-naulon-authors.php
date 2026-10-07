<?php
/**
 * Who wrote a post, read from whichever multi-author plugin the site runs.
 *
 * WordPress itself records one author per post (`post_author`). Sites that credit several people,
 * or guest writers with no WordPress account, use a plugin for it. Each plugin is read by a
 * `Naulon_Byline_Source`; this class asks the active ones in order and reduces every answer to one
 * shape: `{user_id}` for a WordPress account, `{guest_id}` for a guest profile with no account, each
 * with a display name. Nothing here is configured by the site owner.
 *
 * Ids from different plugins are never mixed on one site, so `wp-guest-<n>` is unambiguous there.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Authors {

	/**
	 * The sources asked, in order. Molongui first: its meta is specific to it. PublishPress before
	 * Co-Authors Plus: PublishPress also answers Co-Authors Plus's `get_coauthors()`, and its own
	 * function returns its own ids.
	 *
	 * @return Naulon_Byline_Source[]
	 */
	public static function default_sources() {
		return array( new Naulon_Byline_Molongui(), new Naulon_Byline_PublishPress(), new Naulon_Byline_Coauthors_Plus() );
	}

	/**
	 * The registered sources. Another plugin can add its own reader through the
	 * `naulon_byline_sources` filter; anything that does not implement the interface is ignored.
	 *
	 * @return Naulon_Byline_Source[]
	 */
	public static function sources() {
		/**
		 * Filter the byline sources, in the order they are asked.
		 *
		 * @param Naulon_Byline_Source[] $sources The default sources.
		 */
		$sources = apply_filters( 'naulon_byline_sources', self::default_sources() );
		return array_values(
			array_filter(
				is_array( $sources ) ? $sources : array(),
				function ( $s ) {
					return $s instanceof Naulon_Byline_Source;
				}
			)
		);
	}

	/**
	 * The post's authors in byline order: the first active source that has any for it, or an empty
	 * array, in which case the caller credits the post's own author.
	 *
	 * @param WP_Post $post The post.
	 * @return array[] Each {user_id, name} or {guest_id, name}.
	 */
	public static function for_post( $post ) {
		return self::first_answer( self::sources(), $post );
	}

	/**
	 * The first non-empty answer from the active sources, names filled in.
	 *
	 * @param Naulon_Byline_Source[] $sources The sources, in order.
	 * @param WP_Post                $post    The post.
	 * @return array[]
	 */
	public static function first_answer( $sources, $post ) {
		foreach ( $sources as $source ) {
			if ( ! $source->is_active() ) {
				continue;
			}
			$out = $source->for_post( $post );
			if ( ! empty( $out ) ) {
				return self::with_names( $out );
			}
		}
		return array();
	}

	/**
	 * Author objects from Co-Authors Plus or PublishPress Authors, normalized and de-duplicated.
	 *
	 * Pure: reads only the objects it is given, so it is tested without WordPress. A guest linked to
	 * an account is that account, so an author who appears both ways is credited once.
	 *
	 * @param mixed $authors What the plugin returned.
	 * @return array[] Each {user_id, name?} or {guest_id, name?}.
	 */
	public static function from_objects( $authors ) {
		$out  = array();
		$seen = array();
		foreach ( is_array( $authors ) ? $authors : array() as $a ) {
			if ( ! is_object( $a ) || ! isset( $a->ID ) ) {
				continue;
			}
			$name = isset( $a->display_name ) ? (string) $a->display_name : '';
			if ( isset( $a->type ) && 'guest-author' === $a->type ) {
				// Co-Authors Plus guest: linked to an account, or a profile of its own.
				$linked = isset( $a->wp_user ) && is_object( $a->wp_user ) && isset( $a->wp_user->ID ) ? (int) $a->wp_user->ID : 0;
				$entry  = $linked > 0 ? array( 'user_id' => $linked ) : array( 'guest_id' => (int) $a->ID );
			} else {
				// A WP_User, or a PublishPress Author whose negative id is a guest's term.
				$id = (int) $a->ID;
				if ( 0 === $id ) {
					continue;
				}
				$entry = $id > 0 ? array( 'user_id' => $id ) : array( 'guest_id' => -$id );
			}
			$key = isset( $entry['user_id'] ) ? 'u' . $entry['user_id'] : 'g' . $entry['guest_id'];
			if ( isset( $seen[ $key ] ) ) {
				continue;
			}
			$seen[ $key ] = true;
			if ( '' !== $name ) {
				$entry['name'] = $name;
			}
			$out[] = $entry;
		}
		return $out;
	}

	/**
	 * Molongui `_molongui_author` values (`user-12`, `guest-34`), normalized and de-duplicated.
	 *
	 * @param array $refs The meta values, in stored order.
	 * @return array[] Each {user_id} or {guest_id}.
	 */
	public static function from_molongui_refs( $refs ) {
		$out  = array();
		$seen = array();
		foreach ( $refs as $ref ) {
			if ( ! is_string( $ref ) || ! preg_match( '/^(user|guest)-(\d+)$/', $ref, $m ) || 0 === (int) $m[2] ) {
				continue;
			}
			if ( isset( $seen[ $ref ] ) ) {
				continue;
			}
			$seen[ $ref ] = true;
			$out[]        = 'user' === $m[1] ? array( 'user_id' => (int) $m[2] ) : array( 'guest_id' => (int) $m[2] );
		}
		return $out;
	}

	/**
	 * The naulon author id for an entry: the same string the credits endpoint pays and the catalog
	 * endpoint lists, so every report joins on one id per person.
	 *
	 * @param array $entry {user_id} or {guest_id}.
	 * @return string
	 */
	public static function author_id( $entry ) {
		return isset( $entry['user_id'] ) ? 'wp-user-' . (int) $entry['user_id'] : 'wp-guest-' . (int) $entry['guest_id'];
	}

	/**
	 * Fill a missing name: a user's display name, or a guest profile's title (Molongui guests are
	 * posts). Never fails an entry for want of a name.
	 *
	 * @param array[] $entries Normalized entries.
	 * @return array[]
	 */
	private static function with_names( $entries ) {
		foreach ( $entries as &$e ) {
			if ( isset( $e['name'] ) && '' !== $e['name'] ) {
				continue;
			}
			if ( isset( $e['user_id'] ) ) {
				$user = get_userdata( $e['user_id'] );
				if ( $user ) {
					$e['name'] = $user->display_name;
				}
			} else {
				$title = get_the_title( $e['guest_id'] );
				if ( is_string( $title ) && '' !== $title ) {
					$e['name'] = $title;
				}
			}
		}
		unset( $e );
		return $entries;
	}
}
