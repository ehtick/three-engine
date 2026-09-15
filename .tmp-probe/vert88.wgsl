// Three.js r185 - Node System

// directives


// structs

struct FoliageFadeWeight {
	pivot : vec3<f32>,
	weight : f32,
	distance : f32
};

struct FoliageFade {
	position : vec3<f32>,
	weight : f32,
	distance : f32
};


// uniforms
@binding( 7 ) @group( 1 ) var nodeUniform10_sampler : sampler;
@binding( 8 ) @group( 1 ) var nodeUniform10 : texture_2d<f32>;

struct NodeBuffer_0Struct {
	value : array< mat4x4<f32>, 53 >
};
@binding( 5 ) @group( 1 )
var<uniform> NodeBuffer_0 : NodeBuffer_0Struct;

struct NodeBuffer_1Struct {
	value : array< mat4x4<f32>, 53 >
};
@binding( 6 ) @group( 1 )
var<uniform> NodeBuffer_1 : NodeBuffer_1Struct;

struct objectStruct {
	nodeUniform2 : f32,
	nodeUniform3 : f32,
	nodeUniform4 : vec3<f32>,
	nodeUniform5 : f32,
	nodeUniform6 : f32,
	nodeUniform7 : f32,
	nodeUniform8 : f32,
	nodeUniform9 : f32,
	nodeUniform11 : vec3<f32>,
	nodeUniform12 : f32,
	nodeUniform13 : f32,
	nodeUniform14 : f32,
	nodeUniform15 : f32,
	nodeUniform16 : f32,
	nodeUniform17 : f32,
	nodeUniform18 : vec4<f32>,
	nodeUniform19 : vec4<f32>,
	nodeUniform20 : vec4<f32>,
	nodeUniform21 : vec4<f32>,
	nodeUniform22 : f32,
	nodeUniform23 : vec4<f32>,
	nodeUniform24 : vec4<f32>,
	nodeUniform25 : vec4<f32>,
	nodeUniform26 : vec4<f32>,
	nodeUniform27 : vec4<f32>,
	nodeUniform28 : vec4<f32>,
	nodeUniform29 : vec4<f32>,
	nodeUniform30 : vec4<f32>,
	nodeUniform31 : vec4<f32>,
	nodeUniform32 : vec4<f32>,
	nodeUniform33 : vec4<f32>,
	nodeUniform34 : vec4<f32>,
	nodeUniform35 : vec4<f32>,
	nodeUniform36 : vec4<f32>,
	nodeUniform37 : vec4<f32>,
	nodeUniform38 : vec4<f32>,
	nodeUniform39 : vec4<f32>,
	nodeUniform40 : vec4<f32>,
	nodeUniform41 : vec4<f32>,
	nodeUniform42 : vec4<f32>,
	nodeUniform43 : vec4<f32>,
	nodeUniform44 : vec4<f32>,
	nodeUniform45 : vec4<f32>,
	nodeUniform46 : vec4<f32>,
	nodeUniform47 : vec4<f32>,
	nodeUniform48 : vec4<f32>,
	nodeUniform49 : vec4<f32>,
	nodeUniform50 : vec4<f32>,
	nodeUniform51 : f32,
	nodeUniform54 : f32,
	nodeUniform55 : f32,
	nodeUniform58 : mat4x4<f32>
};
@binding( 4 ) @group( 1 )
var<uniform> object : objectStruct;

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

// varyings

struct VaryingsStruct {
	@location( 0 ) nodeVarying3 : vec4<f32>,
	@location( 1 ) nodeVarying5 : vec2<f32>,
	@builtin( position ) builtinClipSpace : vec4<f32>
};
var<private> varyings : VaryingsStruct;

// vars
var<private> normalLocal : vec3<f32>;
var<private> nodeVar0 : FoliageFade;
var<private> nodeVar1 : vec3<f32>;
var<private> nodeVar2 : FoliageFadeWeight;
var<private> nodeVar3 : f32;
var<private> nodeVar4 : f32;
var<private> nodeVar5 : f32;
var<private> nodeVar6 : f32;
var<private> nodeVar7 : f32;
var<private> nodeVar8 : f32;
var<private> nodeVar9 : f32;
var<private> nodeVar10 : vec3<f32>;
var<private> nodeVar11 : vec3<f32>;
var<private> nodeVar12 : vec3<f32>;
var<private> nodeVar13 : vec3<f32>;
var<private> nodeVar14 : vec2<f32>;
var<private> nodeVar15 : f32;
var<private> nodeVar16 : vec2<f32>;
var<private> nodeVar17 : vec4<f32>;
var<private> nodeVar18 : f32;
var<private> nodeVar19 : vec2<f32>;
var<private> nodeVar20 : vec4<f32>;
var<private> nodeVar21 : vec4<f32>;
var<private> nodeVar22 : f32;
var<private> nodeVar23 : f32;
var<private> nodeVar24 : f32;
var<private> nodeVar25 : f32;
var<private> nodeVar26 : f32;
var<private> nodeVar27 : vec3<f32>;
var<private> nodeVar28 : vec3<f32>;
var<private> nodeVar29 : f32;
var<private> nodeVar30 : f32;
var<private> nodeVar31 : f32;
var<private> nodeVar32 : f32;
var<private> nodeVar33 : vec3<f32>;
var<private> nodeVar34 : vec3<f32>;
var<private> nodeVar35 : f32;
var<private> nodeVar36 : f32;
var<private> nodeVar37 : f32;
var<private> nodeVar38 : f32;
var<private> nodeVar39 : f32;
var<private> nodeVar40 : f32;
var<private> nodeVar41 : f32;
var<private> nodeVar42 : f32;
var<private> nodeVar43 : vec3<f32>;
var<private> nodeVar44 : f32;
var<private> nodeVar45 : f32;
var<private> nodeVar46 : f32;
var<private> nodeVar47 : vec3<f32>;
var<private> nodeVar48 : f32;
var<private> nodeVar49 : f32;
var<private> nodeVar50 : f32;
var<private> nodeVar51 : vec3<f32>;
var<private> nodeVar52 : vec2<f32>;
var<private> nodeVar53 : f32;
var<private> nodeVar54 : vec2<f32>;
var<private> nodeVar55 : vec4<f32>;
var<private> nodeVar56 : f32;
var<private> nodeVar57 : vec2<f32>;
var<private> nodeVar58 : vec4<f32>;
var<private> nodeVar59 : f32;
var<private> nodeVar60 : f32;
var<private> nodeVar61 : f32;
var<private> nodeVar62 : f32;
var<private> nodeVar63 : f32;
var<private> nodeVar64 : f32;
var<private> nodeVar65 : vec3<f32>;
var<private> nodeVar66 : f32;
var<private> nodeVar67 : f32;
var<private> nodeVar68 : f32;
var<private> nodeVar69 : f32;
var<private> nodeVar70 : vec3<f32>;
var<private> nodeVar71 : f32;
var<private> nodeVar72 : f32;
var<private> nodeVar73 : f32;
var<private> nodeVar74 : f32;
var<private> nodeVar75 : f32;
var<private> nodeVar76 : f32;
var<private> nodeVar77 : vec3<f32>;
var<private> nodeVar78 : f32;
var<private> nodeVar79 : f32;
var<private> nodeVar80 : f32;
var<private> nodeVar81 : f32;
var<private> nodeVar82 : vec3<f32>;
var<private> nodeVar83 : vec3<f32>;
var<private> nodeVar84 : f32;
var<private> nodeVar85 : f32;
var<private> nodeVar86 : f32;
var<private> nodeVar87 : vec3<f32>;
var<private> nodeVar88 : vec3<f32>;
var<private> nodeVar89 : f32;
var<private> nodeVar90 : vec3<f32>;
var<private> nodeVar91 : vec3<f32>;
var<private> nodeVar92 : vec3<f32>;
var<private> nodeVar93 : f32;
var<private> nodeVar94 : vec3<f32>;
var<private> nodeVar95 : vec3<f32>;
var<private> nodeVar96 : vec3<f32>;
var<private> nodeVar97 : f32;
var<private> nodeVar98 : vec3<f32>;
var<private> nodeVar99 : vec3<f32>;
var<private> nodeVar100 : vec3<f32>;
var<private> nodeVar101 : f32;
var<private> nodeVar102 : vec3<f32>;
var<private> nodeVar103 : vec3<f32>;
var<private> nodeVar104 : vec3<f32>;
var<private> nodeVar105 : f32;
var<private> nodeVar106 : vec3<f32>;
var<private> nodeVar107 : vec3<f32>;
var<private> nodeVar108 : vec3<f32>;
var<private> nodeVar109 : f32;
var<private> nodeVar110 : vec3<f32>;
var<private> nodeVar111 : vec3<f32>;
var<private> nodeVar112 : vec3<f32>;
var<private> nodeVar113 : f32;
var<private> nodeVar114 : vec3<f32>;
var<private> nodeVar115 : vec3<f32>;
var<private> nodeVar116 : vec3<f32>;
var<private> nodeVar117 : f32;
var<private> nodeVar118 : vec3<f32>;
var<private> nodeVar119 : vec3<f32>;
var<private> nodeVar121 : f32;
var<private> nodeVar122 : f32;
var<private> nodeVar123 : FoliageFadeWeight;
var<private> nodeVar124 : f32;
var<private> nodeVar125 : f32;
var<private> nodeVar126 : f32;
var<private> nodeVar127 : f32;
var<private> nodeVar128 : f32;
var<private> nodeVar129 : f32;
var<private> nodeVar130 : f32;
var<private> nodeVar131 : FoliageFadeWeight;
var<private> nodeVar132 : f32;
var<private> nodeVar133 : f32;
var<private> nodeVar134 : f32;
var<private> nodeVar135 : f32;
var<private> nodeVar136 : f32;
var<private> nodeVar137 : f32;
var<private> nodeVar138 : f32;
var<private> nodeVar139 : f32;
var<private> nodeVar140 : f32;
var<private> nodeVar141 : FoliageFadeWeight;
var<private> nodeVar142 : f32;
var<private> nodeVar143 : f32;
var<private> nodeVar144 : f32;
var<private> nodeVar145 : f32;
var<private> nodeVar146 : f32;
var<private> nodeVar147 : f32;
var<private> nodeVar148 : f32;
var<private> nodeVar149 : f32;
var<private> nodeVar150 : f32;
var<private> nodeVar151 : f32;
var<private> nodeVar152 : f32;
var<private> nodeVar153 : f32;
var<private> nodeVar154 : f32;
var<private> nodeVar155 : f32;
var<private> nodeVar156 : f32;
var<private> nodeVar157 : f32;
var<private> nodeVar158 : f32;
var<private> nodeVar159 : FoliageFadeWeight;
var<private> nodeVar160 : f32;
var<private> nodeVar161 : f32;
var<private> nodeVar162 : f32;
var<private> nodeVar163 : f32;
var<private> nodeVar164 : f32;
var<private> nodeVar165 : f32;
var<private> nodeVar166 : f32;
var<private> nodeVar167 : f32;
var<private> nodeVar168 : f32;
var<private> nodeVar169 : FoliageFadeWeight;
var<private> nodeVar170 : f32;
var<private> nodeVar171 : f32;
var<private> nodeVar172 : f32;
var<private> nodeVar173 : f32;
var<private> nodeVar174 : f32;
var<private> nodeVar175 : f32;
var<private> nodeVar176 : f32;
var<private> nodeVar177 : vec4<f32>;
var<private> modelViewMatrix : mat4x4<f32>;
var<private> VERTEX_nodeVar190 : vec4<f32>;
var<private> positionLocal : vec3<f32>;
var<private> v_modelViewProjection : vec4<f32>;
var<private> v_positionView : vec3<f32>;
var<private> VERTEX_v_modelViewProjection : vec4<f32>;

// codes

fn tsl_inverse_mat3( m : mat3x3<f32> ) -> mat3x3<f32> {

	let a00 = m[ 0 ][ 0 ]; let a01 = m[ 0 ][ 1 ]; let a02 = m[ 0 ][ 2 ];
	let a10 = m[ 1 ][ 0 ]; let a11 = m[ 1 ][ 1 ]; let a12 = m[ 1 ][ 2 ];
	let a20 = m[ 2 ][ 0 ]; let a21 = m[ 2 ][ 1 ]; let a22 = m[ 2 ][ 2 ];

	let b01 = a22 * a11 - a12 * a21;
	let b11 = - a22 * a10 + a12 * a20;
	let b21 = a21 * a10 - a11 * a20;

	let det = a00 * b01 + a01 * b11 + a02 * b21;

	return mat3x3<f32>(
		b01, ( - a22 * a01 + a02 * a21 ), ( a12 * a01 - a02 * a11 ),
		b11, ( a22 * a00 - a02 * a20 ), ( - a12 * a00 + a02 * a10 ),
		b21, ( - a21 * a00 + a01 * a20 ), ( a11 * a00 - a01 * a10 )
	) * ( 1.0 / det );

}



@vertex
fn main( @builtin( instance_index ) instanceIndex : u32,
	@location( 0 ) position : vec3<f32>,
	@location( 1 ) normal : vec3<f32>,
	@location( 2 ) treeLeafAxis : vec4<f32>,
	@location( 3 ) treeLeaf : vec4<f32>,
	@location( 4 ) uv : vec2<f32>,
	@location( 5 ) treeBranch : vec4<f32>,
	@location( 6 ) treeBranchAxis : vec4<f32> ) -> VaryingsStruct {

	// flow
	// code

	positionLocal = position;
	positionLocal = ( NodeBuffer_0.value[ instanceIndex ] * vec4<f32>( positionLocal, 1.0 ) ).xyz;
	normalLocal = normal;
	normalLocal = normalize( ( transpose( tsl_inverse_mat3( mat3x3<f32>( NodeBuffer_0.value[ instanceIndex ][ 0 ].xyz, NodeBuffer_0.value[ instanceIndex ][ 1 ].xyz, NodeBuffer_0.value[ instanceIndex ][ 2 ].xyz ) ) ) * normalLocal ) );

	if ( ( object.nodeUniform2 > 0.5 ) ) {

		nodeVar4 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
		nodeVar5 = ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) );
		nodeVar6 = max( ( object.nodeUniform5 * 0.25 ), 6.0 );
		nodeVar7 = smoothstep( ( object.nodeUniform5 - ( nodeVar6 * 0.5 ) ), ( object.nodeUniform5 + ( nodeVar6 * 0.5 ) ), nodeVar5 );
		nodeVar8 = max( ( object.nodeUniform6 * 0.25 ), 6.0 );
		nodeVar3 = ( ( smoothstep( ( object.nodeUniform3 - ( nodeVar4 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar4 * 0.5 ) ), nodeVar5 ) * ( 1.0 - nodeVar7 ) ) + ( ( nodeVar7 * ( 1.0 - smoothstep( ( object.nodeUniform6 - ( nodeVar8 * 0.5 ) ), ( object.nodeUniform6 + ( nodeVar8 * 0.5 ) ), nodeVar5 ) ) ) * ( 1.0 - object.nodeUniform7 ) ) );

	} else {

		nodeVar9 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
		nodeVar3 = ( 1.0 - smoothstep( ( object.nodeUniform3 - ( nodeVar9 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar9 * 0.5 ) ), ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) ) ) );

	}

	nodeVar2 = FoliageFadeWeight( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz, nodeVar3, ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) ) );

	if ( ( nodeVar2.weight <= 0.001 ) ) {

		nodeVar1 = nodeVar2.pivot;

	} else {

		nodeVar10 = positionLocal;
		nodeVar11 = nodeVar10;

		if ( ( object.nodeUniform8 > 0.0 ) ) {

			nodeVar12 = nodeVar10;

			if ( ( treeLeafAxis.w > 0.5 ) ) {

				nodeVar13 = ( nodeVar12 - ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( treeLeaf.xyz, 1.0 ) ).xyz );
				nodeVar14 = ( object.nodeUniform11.xz / vec2<f32>( max( length( object.nodeUniform11.xz ), 0.0001 ) ) );
				nodeVar15 = ( object.nodeUniform12 * object.nodeUniform13 );
				nodeVar16 = ( vec2<f32>( ( dot( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz.xz, nodeVar14 ) - ( nodeVar15 * 2.0 ) ), dot( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz.xz, vec2<f32>( ( - nodeVar14.y ), nodeVar14.x ) ) ) / vec2<f32>( ( max( object.nodeUniform14, 0.5 ) * 4.0 ) ) );
				nodeVar17 = textureSampleLevel( nodeUniform10, nodeUniform10_sampler, nodeVar16, 0.0 );
				nodeVar18 = ( ( object.nodeUniform15 * 1.8 ) + 0.08 );
				nodeVar19 = ( ( nodeVar16 * vec2<f32>( 3.7 ) ) + vec2<f32>( ( nodeVar15 * 0.007 ), ( nodeVar15 * -0.009 ) ) );
				nodeVar20 = textureSampleLevel( nodeUniform10, nodeUniform10_sampler, nodeVar19, 0.0 );
				nodeVar21 = vec4<f32>( ( 0.2 + ( nodeVar17.x * nodeVar18 ) ), ( ( ( nodeVar20.y * 2.0 ) - 1.0 ) * object.nodeUniform16 ), ( 0.2 + ( nodeVar17.z * nodeVar18 ) ), ( ( nodeVar20.w * 2.0 ) - 1.0 ) );
				nodeVar22 = ( object.nodeUniform12 * object.nodeUniform13 );
				nodeVar23 = ( treeLeaf.w + dot( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz.xz, vec2<f32>( 0.071, 0.093 ) ) );
				nodeVar24 = abs( ( ( fract( ( ( nodeVar22 * 2.13 ) + nodeVar23 ) ) * 2.0 ) - 1.0 ) );
				nodeVar25 = abs( ( ( fract( ( ( nodeVar22 * 3.17 ) + ( nodeVar23 * 0.73 ) ) ) * 2.0 ) - 1.0 ) );
				nodeVar26 = clamp( uv.y, 0.0, 1.0 );
				nodeVar27 = normalize( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( treeLeafAxis.xyz, 0.0 ) ).xyz );
				nodeVar28 = cross( nodeVar27, object.nodeUniform11 );
				nodeVar29 = ( ( ( ( ( object.nodeUniform8 / ( 1.0 + abs( object.nodeUniform8 ) ) ) * ( object.nodeUniform9 * 0.55 ) ) * ( ( nodeVar21.x * 0.12 ) + ( ( ( ( ( ( ( ( nodeVar24 * nodeVar24 ) * ( 3.0 - ( nodeVar24 * 2.0 ) ) ) * 2.0 ) - 1.0 ) * 0.6 ) + ( ( ( ( ( nodeVar25 * nodeVar25 ) * ( 3.0 - ( nodeVar25 * 2.0 ) ) ) * 2.0 ) - 1.0 ) * 0.25 ) ) + ( nodeVar21.w * 0.15 ) ) * object.nodeUniform16 ) ) ) * nodeVar26 ) * min( length( nodeVar28 ), 1.0 ) );
				nodeVar30 = ( nodeVar29 * nodeVar29 );
				nodeVar31 = ( nodeVar30 * nodeVar30 );
				nodeVar32 = ( ( 1.0 - ( nodeVar30 * 0.5 ) ) + ( nodeVar31 / 24.0 ) );
				nodeVar33 = ( nodeVar28 / vec3<f32>( max( length( nodeVar28 ), 0.0001 ) ) );
				nodeVar34 = ( ( ( nodeVar13 * vec3<f32>( nodeVar32 ) ) + ( cross( nodeVar33, nodeVar13 ) * vec3<f32>( ( nodeVar29 * ( ( 1.0 - ( nodeVar30 / 6.0 ) ) + ( nodeVar31 / 120.0 ) ) ) ) ) ) + ( ( nodeVar33 * vec3<f32>( dot( nodeVar33, nodeVar13 ) ) ) * vec3<f32>( ( 1.0 - nodeVar32 ) ) ) );
				nodeVar35 = abs( ( ( fract( ( ( nodeVar22 * 2.71 ) + ( nodeVar23 * 1.37 ) ) ) * 2.0 ) - 1.0 ) );
				nodeVar36 = ( ( ( ( ( object.nodeUniform8 / ( 1.0 + abs( object.nodeUniform8 ) ) ) * ( object.nodeUniform9 * 0.24 ) ) * object.nodeUniform16 ) * ( ( ( ( nodeVar35 * nodeVar35 ) * ( 3.0 - ( nodeVar35 * 2.0 ) ) ) * 2.0 ) - 1.0 ) ) * ( nodeVar26 * nodeVar26 ) );
				nodeVar37 = ( nodeVar36 * nodeVar36 );
				nodeVar38 = ( nodeVar37 * nodeVar37 );
				nodeVar39 = ( ( 1.0 - ( nodeVar37 * 0.5 ) ) + ( nodeVar38 / 24.0 ) );
				nodeVar40 = ( nodeVar29 * nodeVar29 );
				nodeVar41 = ( nodeVar40 * nodeVar40 );
				nodeVar42 = ( ( 1.0 - ( nodeVar40 * 0.5 ) ) + ( nodeVar41 / 24.0 ) );
				nodeVar43 = ( ( ( nodeVar27 * vec3<f32>( nodeVar42 ) ) + ( cross( nodeVar33, nodeVar27 ) * vec3<f32>( ( nodeVar29 * ( ( 1.0 - ( nodeVar40 / 6.0 ) ) + ( nodeVar41 / 120.0 ) ) ) ) ) ) + ( ( nodeVar33 * vec3<f32>( dot( nodeVar33, nodeVar27 ) ) ) * vec3<f32>( ( 1.0 - nodeVar42 ) ) ) );
				nodeVar12 = ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( treeLeaf.xyz, 1.0 ) ).xyz + ( ( ( nodeVar34 * vec3<f32>( nodeVar39 ) ) + ( cross( nodeVar43, nodeVar34 ) * vec3<f32>( ( nodeVar36 * ( ( 1.0 - ( nodeVar37 / 6.0 ) ) + ( nodeVar38 / 120.0 ) ) ) ) ) ) + ( ( nodeVar43 * vec3<f32>( dot( nodeVar43, nodeVar34 ) ) ) * vec3<f32>( ( 1.0 - nodeVar39 ) ) ) ) );
				nodeVar44 = ( nodeVar29 * nodeVar29 );
				nodeVar45 = ( nodeVar44 * nodeVar44 );
				nodeVar46 = ( ( 1.0 - ( nodeVar44 * 0.5 ) ) + ( nodeVar45 / 24.0 ) );
				nodeVar47 = ( ( ( normalLocal * vec3<f32>( nodeVar46 ) ) + ( cross( nodeVar33, normalLocal ) * vec3<f32>( ( nodeVar29 * ( ( 1.0 - ( nodeVar44 / 6.0 ) ) + ( nodeVar45 / 120.0 ) ) ) ) ) ) + ( ( nodeVar33 * vec3<f32>( dot( nodeVar33, normalLocal ) ) ) * vec3<f32>( ( 1.0 - nodeVar46 ) ) ) );
				nodeVar48 = ( nodeVar36 * nodeVar36 );
				nodeVar49 = ( nodeVar48 * nodeVar48 );
				nodeVar50 = ( ( 1.0 - ( nodeVar48 * 0.5 ) ) + ( nodeVar49 / 24.0 ) );
				normalLocal = ( ( ( nodeVar47 * vec3<f32>( nodeVar50 ) ) + ( cross( nodeVar43, nodeVar47 ) * vec3<f32>( ( nodeVar36 * ( ( 1.0 - ( nodeVar48 / 6.0 ) ) + ( nodeVar49 / 120.0 ) ) ) ) ) ) + ( ( nodeVar43 * vec3<f32>( dot( nodeVar43, nodeVar47 ) ) ) * vec3<f32>( ( 1.0 - nodeVar50 ) ) ) );
				

			}

			nodeVar51 = ( nodeVar12 - ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( treeBranch.xyz, 1.0 ) ).xyz );
			nodeVar52 = ( object.nodeUniform11.xz / vec2<f32>( max( length( object.nodeUniform11.xz ), 0.0001 ) ) );
			nodeVar53 = ( object.nodeUniform12 * object.nodeUniform13 );
			nodeVar54 = ( vec2<f32>( ( dot( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz.xz, nodeVar52 ) - ( nodeVar53 * 2.0 ) ), dot( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz.xz, vec2<f32>( ( - nodeVar52.y ), nodeVar52.x ) ) ) / vec2<f32>( ( max( object.nodeUniform14, 0.5 ) * 4.0 ) ) );
			nodeVar55 = textureSampleLevel( nodeUniform10, nodeUniform10_sampler, nodeVar54, 0.0 );
			nodeVar56 = ( ( object.nodeUniform15 * 1.8 ) + 0.08 );
			nodeVar57 = ( ( nodeVar54 * vec2<f32>( 3.7 ) ) + vec2<f32>( ( nodeVar53 * 0.007 ), ( nodeVar53 * -0.009 ) ) );
			nodeVar58 = textureSampleLevel( nodeUniform10, nodeUniform10_sampler, nodeVar57, 0.0 );
			nodeVar59 = ( object.nodeUniform12 * object.nodeUniform13 );
			nodeVar60 = dot( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz.xz, vec2<f32>( 0.071, 0.093 ) );
			nodeVar61 = ( dot( treeBranch.xyz, vec3<f32>( 0.173, 0.327, 0.271 ) ) + nodeVar60 );
			nodeVar62 = abs( ( ( fract( ( ( nodeVar59 * 0.31 ) + nodeVar61 ) ) * 2.0 ) - 1.0 ) );
			nodeVar63 = abs( ( ( fract( ( ( nodeVar59 * 0.53 ) + ( nodeVar61 * 0.71 ) ) ) * 2.0 ) - 1.0 ) );
			nodeVar64 = ( object.nodeUniform8 * ( vec4<f32>( ( 0.2 + ( nodeVar55.x * nodeVar56 ) ), ( ( ( nodeVar58.y * 2.0 ) - 1.0 ) * object.nodeUniform16 ), ( 0.2 + ( nodeVar55.z * nodeVar56 ) ), ( ( nodeVar58.w * 2.0 ) - 1.0 ) ).z + ( ( ( ( ( ( nodeVar62 * nodeVar62 ) * ( 3.0 - ( nodeVar62 * 2.0 ) ) ) * 2.0 ) - 1.0 ) * 0.14 ) + ( ( ( ( ( nodeVar63 * nodeVar63 ) * ( 3.0 - ( nodeVar63 * 2.0 ) ) ) * 2.0 ) - 1.0 ) * 0.06 ) ) ) );
			nodeVar65 = cross( normalize( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( treeBranchAxis.xyz, 0.0 ) ).xyz ), object.nodeUniform11 );
			nodeVar66 = ( ( ( ( nodeVar64 / ( 1.0 + abs( nodeVar64 ) ) ) * ( object.nodeUniform9 * 0.18 ) ) * treeBranch.w ) * min( length( nodeVar65 ), 1.0 ) );
			nodeVar67 = ( nodeVar66 * nodeVar66 );
			nodeVar68 = ( nodeVar67 * nodeVar67 );
			nodeVar69 = ( ( 1.0 - ( nodeVar67 * 0.5 ) ) + ( nodeVar68 / 24.0 ) );
			nodeVar70 = ( nodeVar65 / vec3<f32>( max( length( nodeVar65 ), 0.0001 ) ) );
			nodeVar12 = ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( treeBranch.xyz, 1.0 ) ).xyz + ( ( ( nodeVar51 * vec3<f32>( nodeVar69 ) ) + ( cross( nodeVar70, nodeVar51 ) * vec3<f32>( ( nodeVar66 * ( ( 1.0 - ( nodeVar67 / 6.0 ) ) + ( nodeVar68 / 120.0 ) ) ) ) ) ) + ( ( nodeVar70 * vec3<f32>( dot( nodeVar70, nodeVar51 ) ) ) * vec3<f32>( ( 1.0 - nodeVar69 ) ) ) ) );
			nodeVar71 = ( nodeVar66 * nodeVar66 );
			nodeVar72 = ( nodeVar71 * nodeVar71 );
			nodeVar73 = ( ( 1.0 - ( nodeVar71 * 0.5 ) ) + ( nodeVar72 / 24.0 ) );
			normalLocal = ( ( ( normalLocal * vec3<f32>( nodeVar73 ) ) + ( cross( nodeVar70, normalLocal ) * vec3<f32>( ( nodeVar66 * ( ( 1.0 - ( nodeVar71 / 6.0 ) ) + ( nodeVar72 / 120.0 ) ) ) ) ) ) + ( ( nodeVar70 * vec3<f32>( dot( nodeVar70, normalLocal ) ) ) * vec3<f32>( ( 1.0 - nodeVar73 ) ) ) );
			nodeVar74 = abs( ( ( fract( ( ( nodeVar59 * 0.13 ) + nodeVar60 ) ) * 2.0 ) - 1.0 ) );
			nodeVar75 = ( object.nodeUniform8 * ( vec4<f32>( ( 0.2 + ( nodeVar55.x * nodeVar56 ) ), ( ( ( nodeVar58.y * 2.0 ) - 1.0 ) * object.nodeUniform16 ), ( 0.2 + ( nodeVar55.z * nodeVar56 ) ), ( ( nodeVar58.w * 2.0 ) - 1.0 ) ).z + ( ( ( ( ( nodeVar74 * nodeVar74 ) * ( 3.0 - ( nodeVar74 * 2.0 ) ) ) * 2.0 ) - 1.0 ) * 0.05 ) ) );

			if ( ( treeLeafAxis.w > 0.5 ) ) {

				nodeVar76 = treeLeaf.y;

			} else {

				nodeVar76 = position.y;

			}

			nodeVar77 = cross( normalize( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 1.0, 0.0, 0.0 ) ).xyz ), object.nodeUniform11 );
			nodeVar78 = ( ( ( ( nodeVar75 / ( 1.0 + abs( nodeVar75 ) ) ) * ( object.nodeUniform9 * 0.075 ) ) * clamp( ( nodeVar76 / 14.0 ), 0.0, 1.0 ) ) * min( length( nodeVar77 ), 1.0 ) );
			nodeVar79 = ( nodeVar78 * nodeVar78 );
			nodeVar80 = ( nodeVar79 * nodeVar79 );
			nodeVar81 = ( ( 1.0 - ( nodeVar79 * 0.5 ) ) + ( nodeVar80 / 24.0 ) );
			nodeVar82 = ( nodeVar77 / vec3<f32>( max( length( nodeVar77 ), 0.0001 ) ) );
			normalLocal = ( ( ( normalLocal * vec3<f32>( nodeVar81 ) ) + ( cross( nodeVar82, normalLocal ) * vec3<f32>( ( nodeVar78 * ( ( 1.0 - ( nodeVar79 / 6.0 ) ) + ( nodeVar80 / 120.0 ) ) ) ) ) ) + ( ( nodeVar82 * vec3<f32>( dot( nodeVar82, normalLocal ) ) ) * vec3<f32>( ( 1.0 - nodeVar81 ) ) ) );
			nodeVar83 = ( nodeVar12 - ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz );
			nodeVar84 = ( nodeVar78 * nodeVar78 );
			nodeVar85 = ( nodeVar84 * nodeVar84 );
			nodeVar86 = ( ( 1.0 - ( nodeVar84 * 0.5 ) ) + ( nodeVar85 / 24.0 ) );
			nodeVar11 = ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz + ( ( ( nodeVar83 * vec3<f32>( nodeVar86 ) ) + ( cross( nodeVar82, nodeVar83 ) * vec3<f32>( ( nodeVar78 * ( ( 1.0 - ( nodeVar84 / 6.0 ) ) + ( nodeVar85 / 120.0 ) ) ) ) ) ) + ( ( nodeVar82 * vec3<f32>( dot( nodeVar82, nodeVar83 ) ) ) * vec3<f32>( ( 1.0 - nodeVar86 ) ) ) ) );
			

		}

		nodeVar87 = vec3<f32>( 0.0, 0.0, 0.0 );

		if ( ( object.nodeUniform17 > 0.0 ) ) {


			if ( ( object.nodeUniform18.w > 0.0 ) ) {

				nodeVar88 = ( nodeVar10 - object.nodeUniform18.xyz );

				if ( ( object.nodeUniform18.w > 1.5 ) ) {

					nodeVar89 = max( ( length( vec3<f32>( dot( nodeVar88, object.nodeUniform19.xyz ), dot( nodeVar88, object.nodeUniform20.xyz ), dot( nodeVar88, object.nodeUniform21.xyz ) ) ) - vec3<f32>( object.nodeUniform19.w, object.nodeUniform20.w, object.nodeUniform21.w ).x ), 0.0 );

				} else {

					nodeVar90 = vec3<f32>( dot( nodeVar88, object.nodeUniform19.xyz ), dot( nodeVar88, object.nodeUniform20.xyz ), dot( nodeVar88, object.nodeUniform21.xyz ) );
					nodeVar91 = vec3<f32>( object.nodeUniform19.w, object.nodeUniform20.w, object.nodeUniform21.w );
					nodeVar89 = length( ( nodeVar90 - clamp( nodeVar90, ( - nodeVar91 ), nodeVar91 ) ) );

				}

				nodeVar87 = ( nodeVar87 + ( normalize( vec3<f32>( ( nodeVar88.x + 0.0001 ), 0.0, ( nodeVar88.z + 0.0001 ) ) ) * vec3<f32>( ( ( clamp( ( 1.0 - ( nodeVar89 / max( object.nodeUniform22, 0.01 ) ) ), 0.0, 1.0 ) * clamp( treeBranchAxis.w, 0.0, 1.0 ) ) * object.nodeUniform17 ) ) ) );
				

			}


			if ( ( object.nodeUniform23.w > 0.0 ) ) {

				nodeVar92 = ( nodeVar10 - object.nodeUniform23.xyz );

				if ( ( object.nodeUniform23.w > 1.5 ) ) {

					nodeVar93 = max( ( length( vec3<f32>( dot( nodeVar92, object.nodeUniform24.xyz ), dot( nodeVar92, object.nodeUniform25.xyz ), dot( nodeVar92, object.nodeUniform26.xyz ) ) ) - vec3<f32>( object.nodeUniform24.w, object.nodeUniform25.w, object.nodeUniform26.w ).x ), 0.0 );

				} else {

					nodeVar94 = vec3<f32>( dot( nodeVar92, object.nodeUniform24.xyz ), dot( nodeVar92, object.nodeUniform25.xyz ), dot( nodeVar92, object.nodeUniform26.xyz ) );
					nodeVar95 = vec3<f32>( object.nodeUniform24.w, object.nodeUniform25.w, object.nodeUniform26.w );
					nodeVar93 = length( ( nodeVar94 - clamp( nodeVar94, ( - nodeVar95 ), nodeVar95 ) ) );

				}

				nodeVar87 = ( nodeVar87 + ( normalize( vec3<f32>( ( nodeVar92.x + 0.0001 ), 0.0, ( nodeVar92.z + 0.0001 ) ) ) * vec3<f32>( ( ( clamp( ( 1.0 - ( nodeVar93 / max( object.nodeUniform22, 0.01 ) ) ), 0.0, 1.0 ) * clamp( treeBranchAxis.w, 0.0, 1.0 ) ) * object.nodeUniform17 ) ) ) );
				

			}


			if ( ( object.nodeUniform27.w > 0.0 ) ) {

				nodeVar96 = ( nodeVar10 - object.nodeUniform27.xyz );

				if ( ( object.nodeUniform27.w > 1.5 ) ) {

					nodeVar97 = max( ( length( vec3<f32>( dot( nodeVar96, object.nodeUniform28.xyz ), dot( nodeVar96, object.nodeUniform29.xyz ), dot( nodeVar96, object.nodeUniform30.xyz ) ) ) - vec3<f32>( object.nodeUniform28.w, object.nodeUniform29.w, object.nodeUniform30.w ).x ), 0.0 );

				} else {

					nodeVar98 = vec3<f32>( dot( nodeVar96, object.nodeUniform28.xyz ), dot( nodeVar96, object.nodeUniform29.xyz ), dot( nodeVar96, object.nodeUniform30.xyz ) );
					nodeVar99 = vec3<f32>( object.nodeUniform28.w, object.nodeUniform29.w, object.nodeUniform30.w );
					nodeVar97 = length( ( nodeVar98 - clamp( nodeVar98, ( - nodeVar99 ), nodeVar99 ) ) );

				}

				nodeVar87 = ( nodeVar87 + ( normalize( vec3<f32>( ( nodeVar96.x + 0.0001 ), 0.0, ( nodeVar96.z + 0.0001 ) ) ) * vec3<f32>( ( ( clamp( ( 1.0 - ( nodeVar97 / max( object.nodeUniform22, 0.01 ) ) ), 0.0, 1.0 ) * clamp( treeBranchAxis.w, 0.0, 1.0 ) ) * object.nodeUniform17 ) ) ) );
				

			}


			if ( ( object.nodeUniform31.w > 0.0 ) ) {

				nodeVar100 = ( nodeVar10 - object.nodeUniform31.xyz );

				if ( ( object.nodeUniform31.w > 1.5 ) ) {

					nodeVar101 = max( ( length( vec3<f32>( dot( nodeVar100, object.nodeUniform32.xyz ), dot( nodeVar100, object.nodeUniform33.xyz ), dot( nodeVar100, object.nodeUniform34.xyz ) ) ) - vec3<f32>( object.nodeUniform32.w, object.nodeUniform33.w, object.nodeUniform34.w ).x ), 0.0 );

				} else {

					nodeVar102 = vec3<f32>( dot( nodeVar100, object.nodeUniform32.xyz ), dot( nodeVar100, object.nodeUniform33.xyz ), dot( nodeVar100, object.nodeUniform34.xyz ) );
					nodeVar103 = vec3<f32>( object.nodeUniform32.w, object.nodeUniform33.w, object.nodeUniform34.w );
					nodeVar101 = length( ( nodeVar102 - clamp( nodeVar102, ( - nodeVar103 ), nodeVar103 ) ) );

				}

				nodeVar87 = ( nodeVar87 + ( normalize( vec3<f32>( ( nodeVar100.x + 0.0001 ), 0.0, ( nodeVar100.z + 0.0001 ) ) ) * vec3<f32>( ( ( clamp( ( 1.0 - ( nodeVar101 / max( object.nodeUniform22, 0.01 ) ) ), 0.0, 1.0 ) * clamp( treeBranchAxis.w, 0.0, 1.0 ) ) * object.nodeUniform17 ) ) ) );
				

			}


			if ( ( object.nodeUniform35.w > 0.0 ) ) {

				nodeVar104 = ( nodeVar10 - object.nodeUniform35.xyz );

				if ( ( object.nodeUniform35.w > 1.5 ) ) {

					nodeVar105 = max( ( length( vec3<f32>( dot( nodeVar104, object.nodeUniform36.xyz ), dot( nodeVar104, object.nodeUniform37.xyz ), dot( nodeVar104, object.nodeUniform38.xyz ) ) ) - vec3<f32>( object.nodeUniform36.w, object.nodeUniform37.w, object.nodeUniform38.w ).x ), 0.0 );

				} else {

					nodeVar106 = vec3<f32>( dot( nodeVar104, object.nodeUniform36.xyz ), dot( nodeVar104, object.nodeUniform37.xyz ), dot( nodeVar104, object.nodeUniform38.xyz ) );
					nodeVar107 = vec3<f32>( object.nodeUniform36.w, object.nodeUniform37.w, object.nodeUniform38.w );
					nodeVar105 = length( ( nodeVar106 - clamp( nodeVar106, ( - nodeVar107 ), nodeVar107 ) ) );

				}

				nodeVar87 = ( nodeVar87 + ( normalize( vec3<f32>( ( nodeVar104.x + 0.0001 ), 0.0, ( nodeVar104.z + 0.0001 ) ) ) * vec3<f32>( ( ( clamp( ( 1.0 - ( nodeVar105 / max( object.nodeUniform22, 0.01 ) ) ), 0.0, 1.0 ) * clamp( treeBranchAxis.w, 0.0, 1.0 ) ) * object.nodeUniform17 ) ) ) );
				

			}


			if ( ( object.nodeUniform39.w > 0.0 ) ) {

				nodeVar108 = ( nodeVar10 - object.nodeUniform39.xyz );

				if ( ( object.nodeUniform39.w > 1.5 ) ) {

					nodeVar109 = max( ( length( vec3<f32>( dot( nodeVar108, object.nodeUniform40.xyz ), dot( nodeVar108, object.nodeUniform41.xyz ), dot( nodeVar108, object.nodeUniform42.xyz ) ) ) - vec3<f32>( object.nodeUniform40.w, object.nodeUniform41.w, object.nodeUniform42.w ).x ), 0.0 );

				} else {

					nodeVar110 = vec3<f32>( dot( nodeVar108, object.nodeUniform40.xyz ), dot( nodeVar108, object.nodeUniform41.xyz ), dot( nodeVar108, object.nodeUniform42.xyz ) );
					nodeVar111 = vec3<f32>( object.nodeUniform40.w, object.nodeUniform41.w, object.nodeUniform42.w );
					nodeVar109 = length( ( nodeVar110 - clamp( nodeVar110, ( - nodeVar111 ), nodeVar111 ) ) );

				}

				nodeVar87 = ( nodeVar87 + ( normalize( vec3<f32>( ( nodeVar108.x + 0.0001 ), 0.0, ( nodeVar108.z + 0.0001 ) ) ) * vec3<f32>( ( ( clamp( ( 1.0 - ( nodeVar109 / max( object.nodeUniform22, 0.01 ) ) ), 0.0, 1.0 ) * clamp( treeBranchAxis.w, 0.0, 1.0 ) ) * object.nodeUniform17 ) ) ) );
				

			}


			if ( ( object.nodeUniform43.w > 0.0 ) ) {

				nodeVar112 = ( nodeVar10 - object.nodeUniform43.xyz );

				if ( ( object.nodeUniform43.w > 1.5 ) ) {

					nodeVar113 = max( ( length( vec3<f32>( dot( nodeVar112, object.nodeUniform44.xyz ), dot( nodeVar112, object.nodeUniform45.xyz ), dot( nodeVar112, object.nodeUniform46.xyz ) ) ) - vec3<f32>( object.nodeUniform44.w, object.nodeUniform45.w, object.nodeUniform46.w ).x ), 0.0 );

				} else {

					nodeVar114 = vec3<f32>( dot( nodeVar112, object.nodeUniform44.xyz ), dot( nodeVar112, object.nodeUniform45.xyz ), dot( nodeVar112, object.nodeUniform46.xyz ) );
					nodeVar115 = vec3<f32>( object.nodeUniform44.w, object.nodeUniform45.w, object.nodeUniform46.w );
					nodeVar113 = length( ( nodeVar114 - clamp( nodeVar114, ( - nodeVar115 ), nodeVar115 ) ) );

				}

				nodeVar87 = ( nodeVar87 + ( normalize( vec3<f32>( ( nodeVar112.x + 0.0001 ), 0.0, ( nodeVar112.z + 0.0001 ) ) ) * vec3<f32>( ( ( clamp( ( 1.0 - ( nodeVar113 / max( object.nodeUniform22, 0.01 ) ) ), 0.0, 1.0 ) * clamp( treeBranchAxis.w, 0.0, 1.0 ) ) * object.nodeUniform17 ) ) ) );
				

			}


			if ( ( object.nodeUniform47.w > 0.0 ) ) {

				nodeVar116 = ( nodeVar10 - object.nodeUniform47.xyz );

				if ( ( object.nodeUniform47.w > 1.5 ) ) {

					nodeVar117 = max( ( length( vec3<f32>( dot( nodeVar116, object.nodeUniform48.xyz ), dot( nodeVar116, object.nodeUniform49.xyz ), dot( nodeVar116, object.nodeUniform50.xyz ) ) ) - vec3<f32>( object.nodeUniform48.w, object.nodeUniform49.w, object.nodeUniform50.w ).x ), 0.0 );

				} else {

					nodeVar118 = vec3<f32>( dot( nodeVar116, object.nodeUniform48.xyz ), dot( nodeVar116, object.nodeUniform49.xyz ), dot( nodeVar116, object.nodeUniform50.xyz ) );
					nodeVar119 = vec3<f32>( object.nodeUniform48.w, object.nodeUniform49.w, object.nodeUniform50.w );
					nodeVar117 = length( ( nodeVar118 - clamp( nodeVar118, ( - nodeVar119 ), nodeVar119 ) ) );

				}

				nodeVar87 = ( nodeVar87 + ( normalize( vec3<f32>( ( nodeVar116.x + 0.0001 ), 0.0, ( nodeVar116.z + 0.0001 ) ) ) * vec3<f32>( ( ( clamp( ( 1.0 - ( nodeVar117 / max( object.nodeUniform22, 0.01 ) ) ), 0.0, 1.0 ) * clamp( treeBranchAxis.w, 0.0, 1.0 ) ) * object.nodeUniform17 ) ) ) );
				

			}

			

		}

		nodeVar1 = ( nodeVar11 + ( nodeVar87 / vec3<f32>( max( length( nodeVar87 ), 1.0 ) ) ) );

	}

	nodeVar0 = FoliageFade( nodeVar1, nodeVar2.weight, nodeVar2.distance );
	positionLocal = nodeVar0.position;

	if ( ( object.nodeUniform2 > 0.5 ) ) {


		if ( ( object.nodeUniform2 > 0.5 ) ) {

			nodeVar125 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
			nodeVar126 = ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) );
			nodeVar127 = max( ( object.nodeUniform5 * 0.25 ), 6.0 );
			nodeVar128 = smoothstep( ( object.nodeUniform5 - ( nodeVar127 * 0.5 ) ), ( object.nodeUniform5 + ( nodeVar127 * 0.5 ) ), nodeVar126 );
			nodeVar129 = max( ( object.nodeUniform6 * 0.25 ), 6.0 );
			nodeVar124 = ( ( smoothstep( ( object.nodeUniform3 - ( nodeVar125 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar125 * 0.5 ) ), nodeVar126 ) * ( 1.0 - nodeVar128 ) ) + ( ( nodeVar128 * ( 1.0 - smoothstep( ( object.nodeUniform6 - ( nodeVar129 * 0.5 ) ), ( object.nodeUniform6 + ( nodeVar129 * 0.5 ) ), nodeVar126 ) ) ) * ( 1.0 - object.nodeUniform7 ) ) );

		} else {

			nodeVar130 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
			nodeVar124 = ( 1.0 - smoothstep( ( object.nodeUniform3 - ( nodeVar130 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar130 * 0.5 ) ), ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) ) ) );

		}

		nodeVar123 = FoliageFadeWeight( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz, nodeVar124, ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) ) );

		if ( ( nodeVar123.distance < ( ( object.nodeUniform3 + object.nodeUniform5 ) * 0.5 ) ) ) {

			nodeVar122 = ( ( 1.0 - nodeVar123.weight ) - 2.0 );

		} else {

			nodeVar122 = nodeVar123.weight;

		}

		nodeVar121 = nodeVar122;

	} else {


		if ( ( object.nodeUniform2 > 0.5 ) ) {

			nodeVar133 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
			nodeVar134 = ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) );
			nodeVar135 = max( ( object.nodeUniform5 * 0.25 ), 6.0 );
			nodeVar136 = smoothstep( ( object.nodeUniform5 - ( nodeVar135 * 0.5 ) ), ( object.nodeUniform5 + ( nodeVar135 * 0.5 ) ), nodeVar134 );
			nodeVar137 = max( ( object.nodeUniform6 * 0.25 ), 6.0 );
			nodeVar132 = ( ( smoothstep( ( object.nodeUniform3 - ( nodeVar133 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar133 * 0.5 ) ), nodeVar134 ) * ( 1.0 - nodeVar136 ) ) + ( ( nodeVar136 * ( 1.0 - smoothstep( ( object.nodeUniform6 - ( nodeVar137 * 0.5 ) ), ( object.nodeUniform6 + ( nodeVar137 * 0.5 ) ), nodeVar134 ) ) ) * ( 1.0 - object.nodeUniform7 ) ) );

		} else {

			nodeVar138 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
			nodeVar132 = ( 1.0 - smoothstep( ( object.nodeUniform3 - ( nodeVar138 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar138 * 0.5 ) ), ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) ) ) );

		}

		nodeVar131 = FoliageFadeWeight( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz, nodeVar132, ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) ) );
		nodeVar121 = nodeVar131.weight;

	}


	if ( ( object.nodeUniform2 > 0.5 ) ) {


		if ( ( object.nodeUniform2 > 0.5 ) ) {

			nodeVar143 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
			nodeVar144 = ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) );
			nodeVar145 = max( ( object.nodeUniform5 * 0.25 ), 6.0 );
			nodeVar146 = smoothstep( ( object.nodeUniform5 - ( nodeVar145 * 0.5 ) ), ( object.nodeUniform5 + ( nodeVar145 * 0.5 ) ), nodeVar144 );
			nodeVar147 = max( ( object.nodeUniform6 * 0.25 ), 6.0 );
			nodeVar142 = ( ( smoothstep( ( object.nodeUniform3 - ( nodeVar143 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar143 * 0.5 ) ), nodeVar144 ) * ( 1.0 - nodeVar146 ) ) + ( ( nodeVar146 * ( 1.0 - smoothstep( ( object.nodeUniform6 - ( nodeVar147 * 0.5 ) ), ( object.nodeUniform6 + ( nodeVar147 * 0.5 ) ), nodeVar144 ) ) ) * ( 1.0 - object.nodeUniform7 ) ) );

		} else {

			nodeVar148 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
			nodeVar142 = ( 1.0 - smoothstep( ( object.nodeUniform3 - ( nodeVar148 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar148 * 0.5 ) ), ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) ) ) );

		}

		nodeVar141 = FoliageFadeWeight( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz, nodeVar142, ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) ) );

		if ( ( nodeVar141.distance < ( ( object.nodeUniform3 + object.nodeUniform51 ) * 0.5 ) ) ) {


			if ( ( object.nodeUniform2 > 0.5 ) ) {

				nodeVar150 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
				nodeVar151 = max( ( object.nodeUniform51 * 0.25 ), 6.0 );
				nodeVar149 = ( smoothstep( ( object.nodeUniform3 - ( nodeVar150 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar150 * 0.5 ) ), nodeVar141.distance ) * ( 1.0 - smoothstep( ( object.nodeUniform51 - ( nodeVar151 * 0.5 ) ), ( object.nodeUniform51 + ( nodeVar151 * 0.5 ) ), nodeVar141.distance ) ) );

			} else {

				nodeVar152 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
				nodeVar149 = ( 1.0 - smoothstep( ( object.nodeUniform3 - ( nodeVar152 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar152 * 0.5 ) ), nodeVar141.distance ) );

			}

			nodeVar140 = ( ( 1.0 - nodeVar149 ) - 2.0 );

		} else {


			if ( ( object.nodeUniform2 > 0.5 ) ) {

				nodeVar154 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
				nodeVar155 = max( ( object.nodeUniform51 * 0.25 ), 6.0 );
				nodeVar153 = ( smoothstep( ( object.nodeUniform3 - ( nodeVar154 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar154 * 0.5 ) ), nodeVar141.distance ) * ( 1.0 - smoothstep( ( object.nodeUniform51 - ( nodeVar155 * 0.5 ) ), ( object.nodeUniform51 + ( nodeVar155 * 0.5 ) ), nodeVar141.distance ) ) );

			} else {

				nodeVar156 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
				nodeVar153 = ( 1.0 - smoothstep( ( object.nodeUniform3 - ( nodeVar156 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar156 * 0.5 ) ), nodeVar141.distance ) );

			}

			nodeVar140 = nodeVar153;

		}

		nodeVar139 = nodeVar140;

	} else {


		if ( ( object.nodeUniform2 > 0.5 ) ) {

			nodeVar158 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );

			if ( ( object.nodeUniform2 > 0.5 ) ) {

				nodeVar161 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
				nodeVar162 = ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) );
				nodeVar163 = max( ( object.nodeUniform5 * 0.25 ), 6.0 );
				nodeVar164 = smoothstep( ( object.nodeUniform5 - ( nodeVar163 * 0.5 ) ), ( object.nodeUniform5 + ( nodeVar163 * 0.5 ) ), nodeVar162 );
				nodeVar165 = max( ( object.nodeUniform6 * 0.25 ), 6.0 );
				nodeVar160 = ( ( smoothstep( ( object.nodeUniform3 - ( nodeVar161 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar161 * 0.5 ) ), nodeVar162 ) * ( 1.0 - nodeVar164 ) ) + ( ( nodeVar164 * ( 1.0 - smoothstep( ( object.nodeUniform6 - ( nodeVar165 * 0.5 ) ), ( object.nodeUniform6 + ( nodeVar165 * 0.5 ) ), nodeVar162 ) ) ) * ( 1.0 - object.nodeUniform7 ) ) );

			} else {

				nodeVar166 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
				nodeVar160 = ( 1.0 - smoothstep( ( object.nodeUniform3 - ( nodeVar166 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar166 * 0.5 ) ), ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) ) ) );

			}

			nodeVar159 = FoliageFadeWeight( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz, nodeVar160, ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) ) );
			nodeVar167 = max( ( object.nodeUniform51 * 0.25 ), 6.0 );
			nodeVar157 = ( smoothstep( ( object.nodeUniform3 - ( nodeVar158 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar158 * 0.5 ) ), nodeVar159.distance ) * ( 1.0 - smoothstep( ( object.nodeUniform51 - ( nodeVar167 * 0.5 ) ), ( object.nodeUniform51 + ( nodeVar167 * 0.5 ) ), nodeVar159.distance ) ) );

		} else {

			nodeVar168 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );

			if ( ( object.nodeUniform2 > 0.5 ) ) {

				nodeVar171 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
				nodeVar172 = ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) );
				nodeVar173 = max( ( object.nodeUniform5 * 0.25 ), 6.0 );
				nodeVar174 = smoothstep( ( object.nodeUniform5 - ( nodeVar173 * 0.5 ) ), ( object.nodeUniform5 + ( nodeVar173 * 0.5 ) ), nodeVar172 );
				nodeVar175 = max( ( object.nodeUniform6 * 0.25 ), 6.0 );
				nodeVar170 = ( ( smoothstep( ( object.nodeUniform3 - ( nodeVar171 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar171 * 0.5 ) ), nodeVar172 ) * ( 1.0 - nodeVar174 ) ) + ( ( nodeVar174 * ( 1.0 - smoothstep( ( object.nodeUniform6 - ( nodeVar175 * 0.5 ) ), ( object.nodeUniform6 + ( nodeVar175 * 0.5 ) ), nodeVar172 ) ) ) * ( 1.0 - object.nodeUniform7 ) ) );

			} else {

				nodeVar176 = max( ( object.nodeUniform3 * 0.25 ), 6.0 );
				nodeVar170 = ( 1.0 - smoothstep( ( object.nodeUniform3 - ( nodeVar176 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar176 * 0.5 ) ), ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) ) ) );

			}

			nodeVar169 = FoliageFadeWeight( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz, nodeVar170, ( length( ( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 0.0, 0.0, 0.0, 1.0 ) ).xyz - object.nodeUniform4 ) ) / max( length( ( NodeBuffer_1.value[ instanceIndex ] * vec4<f32>( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), 0.0001 ) ) );
			nodeVar157 = ( 1.0 - smoothstep( ( object.nodeUniform3 - ( nodeVar168 * 0.5 ) ), ( object.nodeUniform3 + ( nodeVar168 * 0.5 ) ), nodeVar169.distance ) );

		}

		nodeVar139 = nodeVar157;

	}

	nodeVar177 = vec4<f32>( nodeVar121, treeLeafAxis.w, nodeVar139, 0.0 );
	varyings.nodeVarying3 = nodeVar177;
	varyings.nodeVarying5 = uv;
	modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform58 );
	v_positionView = ( modelViewMatrix * vec4<f32>( positionLocal, 1.0 ) ).xyz;
	VERTEX_nodeVar190 = ( render.cameraProjectionMatrix * vec4<f32>( v_positionView, 1.0 ) );
	VERTEX_v_modelViewProjection = VERTEX_nodeVar190;

	// result

	varyings.builtinClipSpace = VERTEX_v_modelViewProjection;

	return varyings;

}
