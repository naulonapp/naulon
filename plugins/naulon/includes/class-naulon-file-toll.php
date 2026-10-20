<?php
/**
 * The toll for files in the media library.
 *
 * Apache serves an existing file without loading WordPress, so an opted-in PDF never reached the
 * article toll. Naulon_File_Route rewrites those requests to `index.php?naulon_file=<path>`, and
 * this class answers them: a person gets the file, an agent gets the same 402 an article would
 * give, and a paid agent gets the file with its receipt and licence. The decision is the
 * article's own (Naulon_Enforcer::decide_subject); nothing here prices anything.
 *
 * Every answer from this route is `private, no-store`. A CDN cannot tell a person from an agent,
 * so a copy cached for a person would be handed to the next agent free.
 *
 * The response is planned first and sent second, so every branch is testable without a server.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_File_Toll {

	/** The query var the route rewrites to. */
	const QUERY_VAR = 'naulon_file';

	/** Bytes per read while streaming. */
	const CHUNK = 8192;

	/** @var Naulon_File_Toll|null */
	private static $instance = null;

	/**
	 * @return Naulon_File_Toll
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Hook into WordPress.
	 *
	 * @return void
	 */
	public function register() {
		add_filter( 'query_vars', array( $this, 'add_query_var' ) );
		add_action( 'parse_request', array( $this, 'maybe_serve' ), 0 );
	}

	/**
	 * @param string[] $vars Existing query vars.
	 * @return string[]
	 */
	public function add_query_var( $vars ) {
		$vars[] = self::QUERY_VAR;
		return $vars;
	}

	/**
	 * Answer a routed file request, before any template work.
	 *
	 * @param WP $wp The WordPress environment, mid-parse.
	 * @return void
	 */
	public function maybe_serve( $wp ) {
		if ( ! is_object( $wp ) || empty( $wp->query_vars[ self::QUERY_VAR ] ) || ! is_string( $wp->query_vars[ self::QUERY_VAR ] ) ) {
			return;
		}
		$this->emit( $this->plan( $wp->query_vars[ self::QUERY_VAR ] ) );
	}

	/**
	 * The absolute path of an uploads-relative file this route may serve, or null.
	 *
	 * Only a regular, readable file inside the uploads directory, of a tollable type or under the
	 * probe directory. Anything else (traversal, a symlink out of uploads, a `.php` file someone
	 * uploaded) is answered as missing: this route must never become a way to read the server.
	 *
	 * @param string $rel Path relative to the uploads base, as the rewrite captured it.
	 * @return string|null
	 */
	public function resolve_path( $rel ) {
		$rel = ltrim( rawurldecode( (string) $rel ), '/' );
		if ( '' === $rel || false !== strpos( $rel, "\0" ) ) {
			return null;
		}
		$base = realpath( wp_upload_dir( null, false )['basedir'] );
		$path = realpath( ( false === $base ? '' : $base ) . '/' . $rel );
		if ( false === $base || false === $path || 0 !== strpos( $path, $base . DIRECTORY_SEPARATOR ) ) {
			return null;
		}
		if ( ! is_file( $path ) || ! is_readable( $path ) ) {
			return null;
		}
		$in_probe = 0 === strpos( substr( $path, strlen( $base ) + 1 ), Naulon_File_Probe::DIR . '/' );
		$ext      = strtolower( pathinfo( $path, PATHINFO_EXTENSION ) );
		if ( ! $in_probe && ! in_array( $ext, Naulon_Rules::TOLLABLE_FILE_TYPES, true ) ) {
			return null;
		}
		return $path;
	}

	/**
	 * Decide the whole response for a routed request, without sending anything.
	 *
	 * @param string $rel Path relative to the uploads base.
	 * @return array {status:int, headers:string[], body?:string, file?:string, offset?:int, length?:int}
	 */
	public function plan( $rel ) {
		$path = $this->resolve_path( $rel );
		if ( null === $path ) {
			return array(
				'status'  => 404,
				'headers' => array_merge( Naulon_Enforcer::no_store_headers(), array( 'Content-Type: text/plain; charset=utf-8' ) ),
				'body'    => 'Not found.',
			);
		}

		$base     = realpath( wp_upload_dir( null, false )['basedir'] );
		$relative = str_replace( DIRECTORY_SEPARATOR, '/', substr( $path, strlen( (string) $base ) + 1 ) );
		$url      = trailingslashit( wp_upload_dir( null, false )['baseurl'] ) . $relative;

		if ( 0 === strpos( $relative, Naulon_File_Probe::DIR . '/' ) ) {
			return $this->stream_plan( $path, $this->probe_headers() );
		}

		$file = Naulon_Credits::instance()->resolve_file( $url );
		if ( null === $file ) {
			return $this->stream_plan( $path, array() );
		}

		$enforcer = Naulon_Enforcer::instance();
		$decision = $enforcer->decide_subject( Naulon_Toll_Subject::for_file( $file ) );
		$denial   = $enforcer->denial_response( $decision, $url );
		if ( null !== $denial ) {
			$denial['headers'][] = 'Vary: User-Agent';
			return $denial;
		}
		return $this->stream_plan( $path, Naulon_Enforcer::grant_headers( $decision ) );
	}

	/**
	 * The echo a probe request earns: proof that PHP answered this request, not a cache.
	 *
	 * @return string[]
	 */
	private function probe_headers() {
		$nonce = isset( $_SERVER['HTTP_X_NAULON_PROBE'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_X_NAULON_PROBE'] ) ) : '';
		if ( ! Naulon_File_Probe::instance()->nonce_valid( $nonce ) ) {
			return array();
		}
		return array( Naulon_File_Probe::RESPONSE_HEADER . ': routed; n=' . $nonce );
	}

	/**
	 * Plan a 200, 206, 304 or 416 for a file on disk.
	 *
	 * @param string   $path  Absolute path.
	 * @param string[] $extra Headers to add.
	 * @return array
	 */
	private function stream_plan( $path, array $extra ) {
		$size     = (int) filesize( $path );
		$mtime    = (int) filemtime( $path );
		$etag     = '"' . md5( $path . '|' . $size . '|' . $mtime ) . '"';
		$type     = wp_check_filetype( $path );
		$headers  = array_merge(
			Naulon_Enforcer::no_store_headers(),
			array(
				'Vary: User-Agent',
				'Content-Type: ' . ( $type['type'] ? $type['type'] : 'application/octet-stream' ),
				'Last-Modified: ' . gmdate( 'D, d M Y H:i:s', $mtime ) . ' GMT',
				'ETag: ' . $etag,
				'Accept-Ranges: bytes',
				'X-Content-Type-Options: nosniff',
			),
			$extra
		);

		$if_none_match = isset( $_SERVER['HTTP_IF_NONE_MATCH'] ) ? trim( sanitize_text_field( wp_unslash( $_SERVER['HTTP_IF_NONE_MATCH'] ) ) ) : '';
		if ( '' !== $if_none_match && $if_none_match === $etag ) {
			return array(
				'status'  => 304,
				'headers' => $headers,
				'body'    => '',
			);
		}

		$range = isset( $_SERVER['HTTP_RANGE'] ) ? self::parse_range( sanitize_text_field( wp_unslash( $_SERVER['HTTP_RANGE'] ) ), $size ) : null;
		if ( false === $range ) {
			$headers[] = 'Content-Range: bytes */' . $size;
			return array(
				'status'  => 416,
				'headers' => $headers,
				'body'    => '',
			);
		}
		if ( is_array( $range ) ) {
			list( $start, $end ) = $range;
			$headers[]           = 'Content-Range: bytes ' . $start . '-' . $end . '/' . $size;
			$headers[]           = 'Content-Length: ' . ( $end - $start + 1 );
			return array(
				'status'  => 206,
				'headers' => $headers,
				'file'    => $path,
				'offset'  => $start,
				'length'  => $end - $start + 1,
			);
		}
		$headers[] = 'Content-Length: ' . $size;
		return array(
			'status'  => 200,
			'headers' => $headers,
			'file'    => $path,
			'offset'  => 0,
			'length'  => $size,
		);
	}

	/**
	 * One `bytes=` range. A multi-range or malformed header is ignored (null, the whole file), as
	 * RFC 9110 allows; a range that starts past the end is unsatisfiable (false).
	 *
	 * @param string $header The Range header.
	 * @param int    $size   File size.
	 * @return array|null|false [start, end] inclusive, null to ignore, false for 416.
	 */
	public static function parse_range( $header, $size ) {
		if ( ! preg_match( '/^bytes=(\d*)-(\d*)$/', trim( $header ), $m ) || ( '' === $m[1] && '' === $m[2] ) ) {
			return null;
		}
		if ( '' === $m[1] ) {
			$suffix = (int) $m[2];
			if ( 0 === $suffix || 0 === $size ) {
				return false;
			}
			return array( max( 0, $size - $suffix ), $size - 1 );
		}
		$start = (int) $m[1];
		$end   = '' === $m[2] ? $size - 1 : min( (int) $m[2], $size - 1 );
		if ( $start >= $size || $end < $start ) {
			return false;
		}
		return array( $start, $end );
	}

	/**
	 * Send a plan and stop.
	 *
	 * @param array $plan From plan().
	 * @return void
	 */
	public function emit( array $plan ) {
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- a third-party cache constant, recognized by name.
			define( 'DONOTCACHEPAGE', true );
		}
		while ( ob_get_level() > 0 ) {
			ob_end_clean();
		}
		status_header( $plan['status'] );
		foreach ( $plan['headers'] as $line ) {
			header( $line, 0 !== stripos( $line, 'link:' ) );
		}
		$head = isset( $_SERVER['REQUEST_METHOD'] ) && 'HEAD' === strtoupper( sanitize_text_field( wp_unslash( $_SERVER['REQUEST_METHOD'] ) ) );
		if ( ! $head ) {
			if ( isset( $plan['file'] ) ) {
				$this->stream( $plan['file'], $plan['offset'], $plan['length'] );
			} elseif ( isset( $plan['body'] ) ) {
				echo $plan['body']; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- a fixed string or denial_response()'s escaped body.
			}
		}
		exit;
	}

	/**
	 * Stream a byte range of a file.
	 *
	 * @param string $path   Absolute path.
	 * @param int    $offset First byte.
	 * @param int    $length Bytes to send.
	 * @return void
	 */
	private function stream( $path, $offset, $length ) {
		// phpcs:disable WordPress.WP.AlternativeFunctions -- streaming a byte range of a large file; WP_Filesystem reads whole files into memory.
		$handle = fopen( $path, 'rb' );
		if ( false === $handle ) {
			return;
		}
		fseek( $handle, $offset );
		$left = $length;
		while ( $left > 0 && ! feof( $handle ) ) {
			$chunk = fread( $handle, min( self::CHUNK, $left ) );
			if ( false === $chunk || '' === $chunk ) {
				break;
			}
			echo $chunk; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- file bytes, served as the file's own type with nosniff.
			$left -= strlen( $chunk );
			flush();
		}
		fclose( $handle );
		// phpcs:enable WordPress.WP.AlternativeFunctions
	}
}
