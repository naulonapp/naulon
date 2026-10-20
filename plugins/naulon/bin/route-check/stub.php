<?php
// A stand-in control plane: a fixed policy that opts PDFs in, and a fixed price for anything.
header( 'Content-Type: application/json' );
$path = parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );
if ( '/_naulon/enforce-config' === $path ) {
	file_put_contents( '/tmp/reports.log', ( $_SERVER['HTTP_X_NAULON_FILE_TOLL'] ?? '-' ) . "\n", FILE_APPEND );
	echo json_encode( array(
		'rules'       => array( 'block' => array(), 'free' => array(), 'charge' => array() ),
		'enforcement' => array( 'gateScope' => array( 'mode' => 'site', 'excludePrefixes' => array(), 'includeExtensions' => array( 'pdf' ) ) ),
	) );
	return;
}
if ( '/_naulon/quote' === $path ) {
	echo json_encode( array(
		'slug'   => $_GET['slug'] ?? '',
		'price'  => 5000,
		'payees' => array( array( 'address' => '0x1111111111111111111111111111111111111111', 'shareBps' => 10000 ) ),
		'x402'   => array( 'header' => 'stub-402-header', 'legs' => array( array( 'role' => 'author' ) ) ),
	) );
	return;
}
if ( '/_naulon/reports' === $path ) {
	echo @file_get_contents( '/tmp/reports.log' );
	return;
}
http_response_code( 404 );
echo '{}';
