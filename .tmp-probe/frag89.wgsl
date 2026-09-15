// Three.js r185 - Node System

// global
diagnostic( off, derivative_uniformity );


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms
@binding( 1 ) @group( 1 ) var nodeUniform18_sampler : sampler_comparison;
@binding( 2 ) @group( 1 ) var nodeUniform18 : texture_depth_2d;
@binding( 3 ) @group( 1 ) var nodeUniform20_sampler : sampler;
@binding( 4 ) @group( 1 ) var nodeUniform20 : texture_2d<f32>;
@binding( 5 ) @group( 1 ) var nodeUniform26_sampler : sampler;
@binding( 6 ) @group( 1 ) var nodeUniform26 : texture_2d<f32>;

struct objectStruct {
	nodeUniform1 : mat4x4<f32>,
	nodeUniform2 : f32,
	nodeUniform3 : f32,
	nodeUniform4 : f32,
	nodeUniform6 : mat3x3<f32>,
	nodeUniform7 : vec3<f32>,
	nodeUniform8 : f32,
	nodeUniform21 : f32,
	nodeUniform22 : mat4x4<f32>,
	nodeUniform24 : f32,
	nodeUniform25 : f32,
	nodeUniform27 : f32
};
@binding( 0 ) @group( 1 )
var<uniform> object : objectStruct;

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>,
	nodeUniform9 : vec3<f32>,
	nodeUniform13 : vec3<f32>,
	nodeUniform11 : vec3<f32>,
	nodeUniform12 : vec3<f32>,
	nodeUniform14 : mat4x4<f32>,
	nodeUniform15 : f32,
	nodeUniform16 : f32,
	nodeUniform19 : f32,
	cameraWorldMatrix : mat4x4<f32>,
	nodeUniform17 : vec2<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

// vars
var<private> DiffuseColor : vec4<f32>;
var<private> Metalness : f32;
var<private> Roughness : f32;
var<private> normalViewGeometry : vec3<f32>;
var<private> nodeVar0 : vec3<f32>;
var<private> SpecularColor : vec3<f32>;
var<private> SpecularColorBlended : vec3<f32>;
var<private> SpecularF90 : f32;
var<private> DiffuseContribution : vec3<f32>;
var<private> EmissiveColor : vec3<f32>;
var<private> Output : vec4<f32>;
var<private> irradiance : vec3<f32>;
var<private> nodeVar1 : vec3<f32>;
var<private> NORMAL_normalView : vec3<f32>;
var<private> normalView : vec3<f32>;
var<private> nodeVar2 : vec3<f32>;
var<private> nodeVar3 : vec4<f32>;
var<private> nodeVar4 : vec4<f32>;
var<private> nodeVar5 : vec3<f32>;
var<private> nodeVar6 : vec3<f32>;
var<private> nodeVar7 : f32;
var<private> shadowPositionWorld : vec3<f32>;
var<private> nodeVar8 : f32;
var<private> normalWorld : vec3<f32>;
var<private> nodeVar9 : vec4<f32>;
var<private> nodeVar10 : vec3<f32>;
var<private> nodeVar11 : vec3<f32>;
var<private> nodeVar12 : vec2<f32>;
var<private> nodeVar13 : vec4<f32>;
var<private> nodeVar14 : vec4<f32>;
var<private> nodeVar15 : vec4<f32>;
var<private> nodeVar16 : vec4<f32>;
var<private> nodeVar17 : f32;
var<private> nodeVar18 : vec3<f32>;
var<private> nodeVar19 : vec3<f32>;
var<private> directDiffuse : vec3<f32>;
var<private> nodeVar20 : vec3<f32>;
var<private> nodeVar21 : vec3<f32>;
var<private> nodeVar22 : vec3<f32>;
var<private> directSpecular : vec3<f32>;
var<private> positionViewDirection : vec3<f32>;
var<private> nodeVar23 : vec3<f32>;
var<private> nodeVar24 : f32;
var<private> nodeVar25 : f32;
var<private> nodeVar26 : f32;
var<private> nodeVar27 : vec4<f32>;
var<private> nodeVar28 : vec4<f32>;
var<private> nodeVar29 : vec3<f32>;
var<private> nodeVar30 : f32;
var<private> nodeVar31 : f32;
var<private> nodeVar32 : vec3<f32>;
var<private> nodeVar33 : vec3<f32>;
var<private> nodeVar34 : vec3<f32>;
var<private> radiance : vec3<f32>;
var<private> nodeVar35 : f32;
var<private> nodeVar36 : f32;
var<private> nodeVar37 : f32;
var<private> nodeVar38 : vec3<f32>;
var<private> nodeVar39 : f32;
var<private> nodeVar40 : f32;
var<private> nodeVar41 : f32;
var<private> nodeVar42 : vec2<f32>;
var<private> nodeVar43 : vec4<f32>;
var<private> nodeVar44 : vec3<f32>;
var<private> nodeVar45 : f32;
var<private> nodeVar46 : f32;
var<private> nodeVar47 : f32;
var<private> nodeVar48 : f32;
var<private> nodeVar49 : f32;
var<private> nodeVar50 : vec2<f32>;
var<private> nodeVar51 : vec4<f32>;
var<private> nodeVar52 : vec3<f32>;
var<private> nodeVar53 : vec3<f32>;
var<private> iblIrradiance : vec3<f32>;
var<private> nodeVar54 : f32;
var<private> nodeVar55 : f32;
var<private> nodeVar56 : f32;
var<private> nodeVar57 : f32;
var<private> nodeVar58 : f32;
var<private> nodeVar59 : f32;
var<private> nodeVar60 : vec2<f32>;
var<private> nodeVar61 : vec4<f32>;
var<private> nodeVar62 : vec3<f32>;
var<private> nodeVar63 : f32;
var<private> nodeVar64 : f32;
var<private> nodeVar65 : f32;
var<private> nodeVar66 : f32;
var<private> nodeVar67 : f32;
var<private> nodeVar68 : vec2<f32>;
var<private> nodeVar69 : vec4<f32>;
var<private> nodeVar70 : vec3<f32>;
var<private> nodeVar71 : vec3<f32>;
var<private> nodeVar72 : vec3<f32>;
var<private> nodeVar73 : vec3<f32>;
var<private> nodeVar74 : vec3<f32>;
var<private> indirectDiffuse : vec3<f32>;
var<private> nodeVar75 : vec3<f32>;
var<private> singleScatteringDielectric : vec3<f32>;
var<private> multiScatteringDielectric : vec3<f32>;
var<private> singleScatteringMetallic : vec3<f32>;
var<private> multiScatteringMetallic : vec3<f32>;
var<private> nodeVar76 : f32;
var<private> nodeVar77 : vec4<f32>;
var<private> nodeVar78 : vec3<f32>;
var<private> nodeVar79 : f32;
var<private> nodeVar80 : vec3<f32>;
var<private> nodeVar81 : vec3<f32>;
var<private> nodeVar82 : vec3<f32>;
var<private> nodeVar83 : vec3<f32>;
var<private> nodeVar84 : vec3<f32>;
var<private> nodeVar85 : vec3<f32>;
var<private> nodeVar86 : vec3<f32>;
var<private> nodeVar87 : f32;
var<private> nodeVar88 : f32;
var<private> nodeVar89 : f32;
var<private> nodeVar90 : vec3<f32>;
var<private> nodeVar91 : vec3<f32>;
var<private> nodeVar92 : vec3<f32>;
var<private> nodeVar93 : vec3<f32>;
var<private> nodeVar94 : vec3<f32>;
var<private> nodeVar95 : vec3<f32>;
var<private> nodeVar96 : f32;
var<private> nodeVar97 : vec4<f32>;
var<private> nodeVar98 : vec3<f32>;
var<private> nodeVar99 : f32;
var<private> nodeVar100 : vec3<f32>;
var<private> nodeVar101 : vec3<f32>;
var<private> nodeVar102 : vec3<f32>;
var<private> nodeVar103 : vec3<f32>;
var<private> nodeVar104 : vec3<f32>;
var<private> nodeVar105 : vec3<f32>;
var<private> nodeVar106 : vec3<f32>;
var<private> nodeVar107 : f32;
var<private> nodeVar108 : f32;
var<private> nodeVar109 : f32;
var<private> nodeVar110 : vec3<f32>;
var<private> nodeVar111 : vec3<f32>;
var<private> nodeVar112 : vec3<f32>;
var<private> nodeVar113 : vec3<f32>;
var<private> nodeVar114 : vec3<f32>;
var<private> nodeVar115 : vec3<f32>;
var<private> nodeVar116 : vec3<f32>;
var<private> nodeVar117 : vec3<f32>;
var<private> nodeVar118 : vec3<f32>;
var<private> nodeVar119 : vec3<f32>;
var<private> nodeVar120 : vec3<f32>;
var<private> nodeVar121 : vec3<f32>;
var<private> nodeVar122 : vec3<f32>;
var<private> nodeVar123 : vec3<f32>;
var<private> nodeVar124 : vec3<f32>;
var<private> nodeVar125 : vec3<f32>;
var<private> nodeVar126 : vec3<f32>;
var<private> nodeVar127 : vec3<f32>;
var<private> nodeVar128 : vec3<f32>;
var<private> indirectSpecular : vec3<f32>;
var<private> nodeVar129 : vec3<f32>;
var<private> nodeVar130 : vec3<f32>;
var<private> ambientOcclusion : f32;
var<private> nodeVar131 : vec3<f32>;
var<private> nodeVar132 : f32;
var<private> nodeVar133 : f32;
var<private> nodeVar134 : f32;
var<private> nodeVar135 : f32;
var<private> nodeVar136 : f32;
var<private> nodeVar137 : f32;
var<private> nodeVar138 : f32;
var<private> nodeVar139 : f32;
var<private> nodeVar140 : f32;
var<private> nodeVar141 : f32;
var<private> nodeVar142 : f32;
var<private> nodeVar143 : vec3<f32>;
var<private> totalDiffuse : vec3<f32>;
var<private> nodeVar144 : vec3<f32>;
var<private> totalSpecular : vec3<f32>;
var<private> nodeVar145 : vec3<f32>;
var<private> outgoingLight : vec3<f32>;
var<private> nodeVar146 : vec3<f32>;
var<private> nodeVar147 : vec4<f32>;

// codes
fn V_GGX_SmithCorrelated ( alpha : f32, dotNL : f32, dotNV : f32 ) -> f32 {

	var nodeVar0 : f32;

	nodeVar0 = ( alpha * alpha );

	return ( 0.5 / max( ( ( dotNL * sqrt( ( nodeVar0 + ( ( 1.0 - nodeVar0 ) * ( dotNV * dotNV ) ) ) ) ) + ( dotNV * sqrt( ( nodeVar0 + ( ( 1.0 - nodeVar0 ) * ( dotNL * dotNL ) ) ) ) ) ), 0.000001 ) );

}

fn D_GGX ( alpha : f32, dotNH : f32 ) -> f32 {

	var nodeVar0 : f32;
	var nodeVar1 : f32;

	nodeVar0 = ( alpha * alpha );
	nodeVar1 = ( 1.0 - ( ( dotNH * dotNH ) * ( 1.0 - nodeVar0 ) ) );

	return ( ( nodeVar0 / ( nodeVar1 * nodeVar1 ) ) * 0.3183098861837907 );

}

fn roughnessToMip ( roughness : f32 ) -> f32 {

	var nodeVar0 : f32;

	nodeVar0 = 0.0;

	if ( ( roughness >= 0.8 ) ) {

		nodeVar0 = ( ( ( ( 1.0 - roughness ) * ( -1.0 - -2.0 ) ) / ( 1.0 - 0.8 ) ) + -2.0 );
		

	} else {


		if ( ( roughness >= 0.4 ) ) {

			nodeVar0 = ( ( ( ( 0.8 - roughness ) * ( 2.0 - -1.0 ) ) / ( 0.8 - 0.4 ) ) + -1.0 );
			

		} else {


			if ( ( roughness >= 0.305 ) ) {

				nodeVar0 = ( ( ( ( 0.4 - roughness ) * ( 3.0 - 2.0 ) ) / ( 0.4 - 0.305 ) ) + 2.0 );
				

			} else {


				if ( ( roughness >= 0.21 ) ) {

					nodeVar0 = ( ( ( ( 0.305 - roughness ) * ( 4.0 - 3.0 ) ) / ( 0.305 - 0.21 ) ) + 3.0 );
					

				} else {

					nodeVar0 = ( -2.0 * log2( ( 1.16 * roughness ) ) );
					

				}

				

			}

			

		}

		

	}


	return nodeVar0;

}

fn getFace ( direction : vec3<f32> ) -> f32 {

	var nodeVar0 : vec3<f32>;
	var nodeVar1 : f32;
	var nodeVar2 : f32;
	var nodeVar3 : f32;
	var nodeVar4 : f32;
	var nodeVar5 : f32;

	nodeVar0 = abs( direction );
	nodeVar1 = -1.0;

	if ( ( nodeVar0.x > nodeVar0.z ) ) {


		if ( ( nodeVar0.x > nodeVar0.y ) ) {


			if ( ( direction.x > 0.0 ) ) {

				nodeVar2 = 0.0;

			} else {

				nodeVar2 = 3.0;

			}

			nodeVar1 = nodeVar2;
			

		} else {


			if ( ( direction.y > 0.0 ) ) {

				nodeVar3 = 1.0;

			} else {

				nodeVar3 = 4.0;

			}

			nodeVar1 = nodeVar3;
			

		}

		

	} else {


		if ( ( nodeVar0.z > nodeVar0.y ) ) {


			if ( ( direction.z > 0.0 ) ) {

				nodeVar4 = 2.0;

			} else {

				nodeVar4 = 5.0;

			}

			nodeVar1 = nodeVar4;
			

		} else {


			if ( ( direction.y > 0.0 ) ) {

				nodeVar5 = 1.0;

			} else {

				nodeVar5 = 4.0;

			}

			nodeVar1 = nodeVar5;
			

		}

		

	}


	return nodeVar1;

}

fn getUV ( direction : vec3<f32>, face : f32 ) -> vec2<f32> {

	var nodeVar0 : vec2<f32>;

	nodeVar0 = vec2<f32>( 0.0, 0.0 );

	if ( ( face == 0.0 ) ) {

		nodeVar0 = ( vec2<f32>( direction.z, direction.y ) / vec2<f32>( abs( direction.x ) ) );
		

	} else {


		if ( ( face == 1.0 ) ) {

			nodeVar0 = ( vec2<f32>( ( - direction.x ), ( - direction.z ) ) / vec2<f32>( abs( direction.y ) ) );
			

		} else {


			if ( ( face == 2.0 ) ) {

				nodeVar0 = ( vec2<f32>( ( - direction.x ), direction.y ) / vec2<f32>( abs( direction.z ) ) );
				

			} else {


				if ( ( face == 3.0 ) ) {

					nodeVar0 = ( vec2<f32>( ( - direction.z ), direction.y ) / vec2<f32>( abs( direction.x ) ) );
					

				} else {


					if ( ( face == 4.0 ) ) {

						nodeVar0 = ( vec2<f32>( ( - direction.x ), direction.z ) / vec2<f32>( abs( direction.y ) ) );
						

					} else {

						nodeVar0 = ( vec2<f32>( direction.x, direction.y ) / vec2<f32>( abs( direction.z ) ) );
						

					}

					

				}

				

			}

			

		}

		

	}


	return ( vec2<f32>( 0.5 ) * ( nodeVar0 + vec2<f32>( 1.0 ) ) );

}



@fragment
fn main( @location( 0 ) v_positionWorld : vec3<f32>,
	@location( 1 ) v_normalViewGeometry : vec3<f32>,
	@location( 2 ) v_positionViewDirection : vec3<f32>,
	@location( 3 ) nodeVarying7 : vec3<f32> ) -> OutputStruct {

	// flow
	// code

	DiffuseColor = ( vec4<f32>( ( nodeVarying7 * vec3<f32>( ( ( sin( ( ( v_positionWorld.y * 1.9 ) + ( v_positionWorld.x * 0.07 ) ) ) * 0.035 ) + 1.0 ) ) ), 1.0 ) * vec4<f32>( nodeVarying7, 1.0 ) );
	DiffuseColor.w = ( DiffuseColor.w * object.nodeUniform2 );
	DiffuseColor.w = 1.0;
	Metalness = object.nodeUniform3;
	normalViewGeometry = normalize( v_normalViewGeometry );
	nodeVar0 = max( abs( dpdx( normalViewGeometry ) ), abs( - dpdy( normalViewGeometry ) ) );
	Roughness = min( ( max( object.nodeUniform4, 0.0525 ) + max( max( nodeVar0.x, nodeVar0.y ), nodeVar0.z ) ), 1.0 );
	SpecularColor = vec3<f32>( 0.04, 0.04, 0.04 );
	SpecularColorBlended = mix( vec3<f32>( 0.04, 0.04, 0.04 ), DiffuseColor.xyz, Metalness );
	SpecularF90 = 1.0;
	DiffuseContribution = ( DiffuseColor.xyz * vec3<f32>( ( 1.0 - object.nodeUniform3 ) ) );
	EmissiveColor = ( object.nodeUniform7 * vec3<f32>( object.nodeUniform8 ) );
	irradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar1 = ( irradiance + render.nodeUniform9 );
	irradiance = nodeVar1;
	NORMAL_normalView = normalViewGeometry;
	normalView = NORMAL_normalView;
	nodeVar2 = ( render.nodeUniform11 - render.nodeUniform12 );
	nodeVar3 = vec4<f32>( nodeVar2, 0.0 );
	nodeVar4 = ( render.cameraViewMatrix * nodeVar3 );
	nodeVar5 = normalize( nodeVar4.xyz );
	nodeVar6 = nodeVar5;
	nodeVar7 = dot( normalView, nodeVar6 );
	shadowPositionWorld = v_positionWorld;
	normalWorld = normalize( ( vec4<f32>( normalView, 0.0 ) * render.cameraViewMatrix ).xyz );
	nodeVar9 = ( render.nodeUniform14 * vec4<f32>( ( shadowPositionWorld + ( normalWorld * vec3<f32>( render.nodeUniform15 ) ) ), 1.0 ) );
	nodeVar10 = ( nodeVar9.xyz / vec3<f32>( nodeVar9.w ) );
	nodeVar11 = vec3<f32>( nodeVar10.x, ( 1.0 - nodeVar10.y ), ( nodeVar10.z + render.nodeUniform16 ) );

	if ( ( ( ( ( ( nodeVar11.x >= 0.0 ) && ( nodeVar11.x <= 1.0 ) ) && ( nodeVar11.y >= 0.0 ) ) && ( nodeVar11.y <= 1.0 ) ) && ( nodeVar11.z <= 1.0 ) ) ) {

		let nodeConst0 = fract( ( ( nodeVar11.xy * render.nodeUniform17 ) + vec2<f32>( 0.5 ) ) );
		nodeVar12 = ( nodeVar11.xy - ( ( nodeConst0 - vec2<f32>( 0.5 ) ) * ( vec2<f32>( 1.0, 1.0 ) / render.nodeUniform17 ) ) );
		nodeVar11.x = nodeVar12[ 0 ];
		nodeVar11.y = nodeVar12[ 1 ];
		nodeVar13 = textureGatherCompare( nodeUniform18, nodeUniform18_sampler, nodeVar11.xy, nodeVar11.z, vec2<i32>( -1, 1 ) );
		let nodeConst1 = nodeVar13;
		nodeVar14 = textureGatherCompare( nodeUniform18, nodeUniform18_sampler, nodeVar11.xy, nodeVar11.z, vec2<i32>( 1, 1 ) );
		let nodeConst2 = nodeVar14;
		nodeVar15 = textureGatherCompare( nodeUniform18, nodeUniform18_sampler, nodeVar11.xy, nodeVar11.z, vec2<i32>( -1, -1 ) );
		let nodeConst3 = nodeVar15;
		nodeVar16 = textureGatherCompare( nodeUniform18, nodeUniform18_sampler, nodeVar11.xy, nodeVar11.z, vec2<i32>( 1, -1 ) );
		let nodeConst4 = nodeVar16;
		nodeVar8 = ( ( ( ( ( ( ( mix( nodeConst1.x, nodeConst2.y, nodeConst0.x ) + nodeConst1.y ) + nodeConst2.x ) * nodeConst0.y ) + ( ( mix( nodeConst1.w, nodeConst2.z, nodeConst0.x ) + nodeConst1.z ) + nodeConst2.w ) ) + ( ( mix( nodeConst3.x, nodeConst4.y, nodeConst0.x ) + nodeConst3.y ) + nodeConst4.x ) ) + ( ( ( mix( nodeConst3.w, nodeConst4.z, nodeConst0.x ) + nodeConst3.z ) + nodeConst4.w ) * ( 1.0 - nodeConst0.y ) ) ) * 0.1111111111111111 );

	} else {

		nodeVar8 = 1.0;

	}

	nodeVar17 = mix( 1.0, nodeVar8, render.nodeUniform19 );
	nodeVar18 = ( vec3<f32>( clamp( nodeVar7, 0.0, 1.0 ) ) * ( render.nodeUniform13 * vec3<f32>( nodeVar17 ) ) );
	nodeVar19 = nodeVar18;
	directDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar20 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar21 = ( nodeVar19 * nodeVar20 );
	nodeVar22 = ( directDiffuse + nodeVar21 );
	directDiffuse = nodeVar22;
	directSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	positionViewDirection = normalize( v_positionViewDirection );
	nodeVar23 = normalize( ( nodeVar6 + positionViewDirection ) );
	nodeVar24 = clamp( dot( positionViewDirection, nodeVar23 ), 0.0, 1.0 );
	nodeVar25 = exp2( ( ( ( nodeVar24 * -5.55473 ) - 6.98316 ) * nodeVar24 ) );
	nodeVar26 = ( Roughness * Roughness );
	nodeVar27 = textureSample( nodeUniform20, nodeUniform20_sampler, vec2<f32>( Roughness, clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) );
	nodeVar28 = textureSample( nodeUniform20, nodeUniform20_sampler, vec2<f32>( Roughness, clamp( dot( normalView, nodeVar6 ), 0.0, 1.0 ) ) );
	nodeVar29 = ( SpecularColorBlended + ( ( vec3<f32>( 1.0 ) - SpecularColorBlended ) * vec3<f32>( 0.047619 ) ) );
	nodeVar30 = ( 1.0 - ( nodeVar27.xy.x + nodeVar27.xy.y ) );
	nodeVar31 = ( 1.0 - ( nodeVar28.xy.x + nodeVar28.xy.y ) );
	nodeVar32 = ( ( ( ( ( SpecularColorBlended * vec3<f32>( ( 1.0 - nodeVar25 ) ) ) + vec3<f32>( ( 1.0 * nodeVar25 ) ) ) * vec3<f32>( V_GGX_SmithCorrelated( nodeVar26, clamp( dot( normalView, nodeVar6 ), 0.0, 1.0 ), clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( D_GGX( nodeVar26, clamp( dot( normalView, nodeVar23 ), 0.0, 1.0 ) ) ) ) + ( ( ( ( ( ( SpecularColorBlended * vec3<f32>( nodeVar27.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar27.xy.y ) ) ) * ( ( SpecularColorBlended * vec3<f32>( nodeVar28.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar28.xy.y ) ) ) ) * nodeVar29 ) / ( ( vec3<f32>( 1.0 ) - ( ( vec3<f32>( ( nodeVar30 * nodeVar31 ) ) * nodeVar29 ) * nodeVar29 ) ) + vec3<f32>( 0.000001 ) ) ) * vec3<f32>( ( nodeVar30 * nodeVar31 ) ) ) );
	nodeVar33 = ( nodeVar19 * nodeVar32 );
	nodeVar34 = ( directSpecular + nodeVar33 );
	directSpecular = nodeVar34;
	radiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar35 = clamp( roughnessToMip( Roughness ), -2.0, object.nodeUniform21 );
	nodeVar36 = floor( nodeVar35 );
	nodeVar37 = nodeVar36;
	nodeVar38 = normalize( ( render.cameraWorldMatrix * vec4<f32>( normalize( mix( reflect( ( - positionViewDirection ), normalView ), normalView, ( ( ( Roughness * Roughness ) * Roughness ) * Roughness ) ) ), 0.0 ) ).xyz );
	nodeVar39 = getFace( ( object.nodeUniform22 * vec4<f32>( vec3<f32>( nodeVar38.x, ( - nodeVar38.y ), nodeVar38.z ), 1.0 ) ).xyz );
	nodeVar40 = max( ( 4.0 - nodeVar37 ), 0.0 );
	nodeVar37 = max( nodeVar37, 4.0 );
	nodeVar41 = exp2( nodeVar37 );
	nodeVar42 = ( ( getUV( ( object.nodeUniform22 * vec4<f32>( vec3<f32>( nodeVar38.x, ( - nodeVar38.y ), nodeVar38.z ), 1.0 ) ).xyz, nodeVar39 ) * vec2<f32>( ( nodeVar41 - 2.0 ) ) ) + vec2<f32>( 1.0 ) );

	if ( ( nodeVar39 > 2.0 ) ) {

		nodeVar42.y = ( nodeVar42.y + nodeVar41 );
		nodeVar39 = ( nodeVar39 - 3.0 );
		

	}

	nodeVar42.x = ( nodeVar42.x + ( nodeVar39 * nodeVar41 ) );
	nodeVar42.x = ( nodeVar42.x + ( nodeVar40 * ( 3.0 * 16.0 ) ) );
	nodeVar42.y = ( nodeVar42.y + ( 4.0 * ( exp2( object.nodeUniform21 ) - nodeVar41 ) ) );
	nodeVar42.x = ( nodeVar42.x * object.nodeUniform24 );
	nodeVar42.y = ( nodeVar42.y * object.nodeUniform25 );
	nodeVar43 = textureSampleGrad( nodeUniform26, nodeUniform26_sampler, nodeVar42, vec2<f32>( 0.0, 0.0 ), vec2<f32>( 0.0, 0.0 ) );
	nodeVar44 = nodeVar43.xyz;
	nodeVar45 = fract( nodeVar35 );

	if ( ( nodeVar45 != 0.0 ) ) {

		nodeVar46 = ( nodeVar36 + 1.0 );
		nodeVar47 = getFace( ( object.nodeUniform22 * vec4<f32>( vec3<f32>( nodeVar38.x, ( - nodeVar38.y ), nodeVar38.z ), 1.0 ) ).xyz );
		nodeVar48 = max( ( 4.0 - nodeVar46 ), 0.0 );
		nodeVar46 = max( nodeVar46, 4.0 );
		nodeVar49 = exp2( nodeVar46 );
		nodeVar50 = ( ( getUV( ( object.nodeUniform22 * vec4<f32>( vec3<f32>( nodeVar38.x, ( - nodeVar38.y ), nodeVar38.z ), 1.0 ) ).xyz, nodeVar47 ) * vec2<f32>( ( nodeVar49 - 2.0 ) ) ) + vec2<f32>( 1.0 ) );

		if ( ( nodeVar47 > 2.0 ) ) {

			nodeVar50.y = ( nodeVar50.y + nodeVar49 );
			nodeVar47 = ( nodeVar47 - 3.0 );
			

		}

		nodeVar50.x = ( nodeVar50.x + ( nodeVar47 * nodeVar49 ) );
		nodeVar50.x = ( nodeVar50.x + ( nodeVar48 * ( 3.0 * 16.0 ) ) );
		nodeVar50.y = ( nodeVar50.y + ( 4.0 * ( exp2( object.nodeUniform21 ) - nodeVar49 ) ) );
		nodeVar50.x = ( nodeVar50.x * object.nodeUniform24 );
		nodeVar50.y = ( nodeVar50.y * object.nodeUniform25 );
		nodeVar51 = textureSampleGrad( nodeUniform26, nodeUniform26_sampler, nodeVar50, vec2<f32>( 0.0, 0.0 ), vec2<f32>( 0.0, 0.0 ) );
		nodeVar52 = nodeVar51.xyz;
		nodeVar44 = mix( nodeVar44, nodeVar52, nodeVar45 );
		

	}

	nodeVar53 = ( radiance + ( nodeVar44 * vec3<f32>( object.nodeUniform27 ) ) );
	radiance = nodeVar53;
	iblIrradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar54 = clamp( roughnessToMip( 1.0 ), -2.0, object.nodeUniform21 );
	nodeVar55 = floor( nodeVar54 );
	nodeVar56 = nodeVar55;
	nodeVar57 = getFace( ( object.nodeUniform22 * vec4<f32>( vec3<f32>( normalWorld.x, ( - normalWorld.y ), normalWorld.z ), 1.0 ) ).xyz );
	nodeVar58 = max( ( 4.0 - nodeVar56 ), 0.0 );
	nodeVar56 = max( nodeVar56, 4.0 );
	nodeVar59 = exp2( nodeVar56 );
	nodeVar60 = ( ( getUV( ( object.nodeUniform22 * vec4<f32>( vec3<f32>( normalWorld.x, ( - normalWorld.y ), normalWorld.z ), 1.0 ) ).xyz, nodeVar57 ) * vec2<f32>( ( nodeVar59 - 2.0 ) ) ) + vec2<f32>( 1.0 ) );

	if ( ( nodeVar57 > 2.0 ) ) {

		nodeVar60.y = ( nodeVar60.y + nodeVar59 );
		nodeVar57 = ( nodeVar57 - 3.0 );
		

	}

	nodeVar60.x = ( nodeVar60.x + ( nodeVar57 * nodeVar59 ) );
	nodeVar60.x = ( nodeVar60.x + ( nodeVar58 * ( 3.0 * 16.0 ) ) );
	nodeVar60.y = ( nodeVar60.y + ( 4.0 * ( exp2( object.nodeUniform21 ) - nodeVar59 ) ) );
	nodeVar60.x = ( nodeVar60.x * object.nodeUniform24 );
	nodeVar60.y = ( nodeVar60.y * object.nodeUniform25 );
	nodeVar61 = textureSampleGrad( nodeUniform26, nodeUniform26_sampler, nodeVar60, vec2<f32>( 0.0, 0.0 ), vec2<f32>( 0.0, 0.0 ) );
	nodeVar62 = nodeVar61.xyz;
	nodeVar63 = fract( nodeVar54 );

	if ( ( nodeVar63 != 0.0 ) ) {

		nodeVar64 = ( nodeVar55 + 1.0 );
		nodeVar65 = getFace( ( object.nodeUniform22 * vec4<f32>( vec3<f32>( normalWorld.x, ( - normalWorld.y ), normalWorld.z ), 1.0 ) ).xyz );
		nodeVar66 = max( ( 4.0 - nodeVar64 ), 0.0 );
		nodeVar64 = max( nodeVar64, 4.0 );
		nodeVar67 = exp2( nodeVar64 );
		nodeVar68 = ( ( getUV( ( object.nodeUniform22 * vec4<f32>( vec3<f32>( normalWorld.x, ( - normalWorld.y ), normalWorld.z ), 1.0 ) ).xyz, nodeVar65 ) * vec2<f32>( ( nodeVar67 - 2.0 ) ) ) + vec2<f32>( 1.0 ) );

		if ( ( nodeVar65 > 2.0 ) ) {

			nodeVar68.y = ( nodeVar68.y + nodeVar67 );
			nodeVar65 = ( nodeVar65 - 3.0 );
			

		}

		nodeVar68.x = ( nodeVar68.x + ( nodeVar65 * nodeVar67 ) );
		nodeVar68.x = ( nodeVar68.x + ( nodeVar66 * ( 3.0 * 16.0 ) ) );
		nodeVar68.y = ( nodeVar68.y + ( 4.0 * ( exp2( object.nodeUniform21 ) - nodeVar67 ) ) );
		nodeVar68.x = ( nodeVar68.x * object.nodeUniform24 );
		nodeVar68.y = ( nodeVar68.y * object.nodeUniform25 );
		nodeVar69 = textureSampleGrad( nodeUniform26, nodeUniform26_sampler, nodeVar68, vec2<f32>( 0.0, 0.0 ), vec2<f32>( 0.0, 0.0 ) );
		nodeVar70 = nodeVar69.xyz;
		nodeVar62 = mix( nodeVar62, nodeVar70, nodeVar63 );
		

	}

	nodeVar71 = ( iblIrradiance + ( ( nodeVar62 * vec3<f32>( 3.141592653589793 ) ) * vec3<f32>( object.nodeUniform27 ) ) );
	iblIrradiance = nodeVar71;
	nodeVar72 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar73 = ( irradiance * nodeVar72 );
	nodeVar74 = nodeVar73;
	indirectDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar75 = ( indirectDiffuse + nodeVar74 );
	indirectDiffuse = nodeVar75;
	singleScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	singleScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar76 = dot( normalView, positionViewDirection );
	nodeVar77 = textureSample( nodeUniform20, nodeUniform20_sampler, vec2<f32>( Roughness, clamp( nodeVar76, 0.0, 1.0 ) ) );
	nodeVar78 = ( SpecularColor * vec3<f32>( nodeVar77.xy.x ) );
	nodeVar79 = ( SpecularF90 * nodeVar77.xy.y );
	nodeVar80 = ( nodeVar78 + vec3<f32>( nodeVar79 ) );
	nodeVar81 = ( singleScatteringDielectric + nodeVar80 );
	singleScatteringDielectric = nodeVar81;
	nodeVar82 = ( vec3<f32>( 1.0 ) - SpecularColor );
	nodeVar83 = nodeVar82;
	nodeVar84 = ( nodeVar83 * vec3<f32>( 0.047619 ) );
	nodeVar85 = ( SpecularColor + nodeVar84 );
	nodeVar86 = ( nodeVar80 * nodeVar85 );
	nodeVar87 = ( nodeVar77.xy.x + nodeVar77.xy.y );
	nodeVar88 = ( 1.0 - nodeVar87 );
	nodeVar89 = nodeVar88;
	nodeVar90 = ( vec3<f32>( nodeVar89 ) * nodeVar85 );
	nodeVar91 = ( vec3<f32>( 1.0 ) - nodeVar90 );
	nodeVar92 = nodeVar91;
	nodeVar93 = ( nodeVar86 / nodeVar92 );
	nodeVar94 = ( nodeVar93 * vec3<f32>( nodeVar89 ) );
	nodeVar95 = ( multiScatteringDielectric + nodeVar94 );
	multiScatteringDielectric = nodeVar95;
	nodeVar96 = dot( normalView, positionViewDirection );
	nodeVar97 = textureSample( nodeUniform20, nodeUniform20_sampler, vec2<f32>( Roughness, clamp( nodeVar96, 0.0, 1.0 ) ) );
	nodeVar98 = ( DiffuseColor.xyz * vec3<f32>( nodeVar97.xy.x ) );
	nodeVar99 = ( SpecularF90 * nodeVar97.xy.y );
	nodeVar100 = ( nodeVar98 + vec3<f32>( nodeVar99 ) );
	nodeVar101 = ( singleScatteringMetallic + nodeVar100 );
	singleScatteringMetallic = nodeVar101;
	nodeVar102 = ( vec3<f32>( 1.0 ) - DiffuseColor.xyz );
	nodeVar103 = nodeVar102;
	nodeVar104 = ( nodeVar103 * vec3<f32>( 0.047619 ) );
	nodeVar105 = ( DiffuseColor.xyz + nodeVar104 );
	nodeVar106 = ( nodeVar100 * nodeVar105 );
	nodeVar107 = ( nodeVar97.xy.x + nodeVar97.xy.y );
	nodeVar108 = ( 1.0 - nodeVar107 );
	nodeVar109 = nodeVar108;
	nodeVar110 = ( vec3<f32>( nodeVar109 ) * nodeVar105 );
	nodeVar111 = ( vec3<f32>( 1.0 ) - nodeVar110 );
	nodeVar112 = nodeVar111;
	nodeVar113 = ( nodeVar106 / nodeVar112 );
	nodeVar114 = ( nodeVar113 * vec3<f32>( nodeVar109 ) );
	nodeVar115 = ( multiScatteringMetallic + nodeVar114 );
	multiScatteringMetallic = nodeVar115;
	nodeVar116 = mix( singleScatteringDielectric, singleScatteringMetallic, Metalness );
	nodeVar117 = ( radiance * nodeVar116 );
	nodeVar118 = mix( multiScatteringDielectric, multiScatteringMetallic, Metalness );
	nodeVar119 = ( iblIrradiance * vec3<f32>( 0.3183098861837907 ) );
	nodeVar120 = ( nodeVar118 * nodeVar119 );
	nodeVar121 = ( nodeVar117 + nodeVar120 );
	nodeVar122 = nodeVar121;
	nodeVar123 = ( singleScatteringDielectric + multiScatteringDielectric );
	nodeVar124 = ( vec3<f32>( 1.0 ) - nodeVar123 );
	nodeVar125 = nodeVar124;
	nodeVar126 = ( DiffuseContribution * nodeVar125 );
	nodeVar127 = ( nodeVar126 * nodeVar119 );
	nodeVar128 = nodeVar127;
	indirectSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar129 = ( indirectSpecular + nodeVar122 );
	indirectSpecular = nodeVar129;
	nodeVar130 = ( indirectDiffuse + nodeVar128 );
	indirectDiffuse = nodeVar130;
	ambientOcclusion = 1.0;
	nodeVar131 = ( indirectDiffuse * vec3<f32>( ambientOcclusion ) );
	indirectDiffuse = nodeVar131;
	nodeVar132 = dot( normalView, positionViewDirection );
	nodeVar133 = ( clamp( nodeVar132, 0.0, 1.0 ) + ambientOcclusion );
	nodeVar134 = ( Roughness * -16.0 );
	nodeVar135 = ( 1.0 - nodeVar134 );
	nodeVar136 = nodeVar135;
	nodeVar137 = ( - nodeVar136 );
	nodeVar138 = exp2( nodeVar137 );
	nodeVar139 = pow( nodeVar133, nodeVar138 );
	nodeVar140 = ( 1.0 - nodeVar139 );
	nodeVar141 = nodeVar140;
	nodeVar142 = ( ambientOcclusion - nodeVar141 );
	nodeVar143 = ( indirectSpecular * vec3<f32>( clamp( nodeVar142, 0.0, 1.0 ) ) );
	indirectSpecular = nodeVar143;
	nodeVar144 = ( directDiffuse + indirectDiffuse );
	totalDiffuse = nodeVar144;
	nodeVar145 = ( directSpecular + indirectSpecular );
	totalSpecular = nodeVar145;
	nodeVar146 = ( totalDiffuse + totalSpecular );
	outgoingLight = nodeVar146;
	nodeVar147 = max( vec4<f32>( ( outgoingLight + EmissiveColor ), DiffuseColor.w ), vec4<f32>( 0.0 ) );
	Output = nodeVar147;

	// result

	output.color = nodeVar147;

	return output;

}
