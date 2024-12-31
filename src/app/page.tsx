'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF, Environment } from '@react-three/drei';
import { useRef, useEffect, useState, Suspense, MutableRefObject, useMemo } from 'react';
import * as THREE from 'three';
import { EffectComposer, Bloom, Noise } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import Link from 'next/link';

// シェーダーのコード
const vertexShader = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = `
  uniform sampler2D videoTexture;
  uniform sampler2D normalMap;
  uniform float time;
  uniform float audioLevel;
  uniform float bassLevel;
  uniform float midLevel;
  uniform float trebleLevel;
  uniform float glitchIntensity;  // グリッチの強度
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;

  // フレネル効果の計算
  float fresnel(vec3 viewDir, vec3 normal) {
    float F0 = 0.02;
    float cosTheta = max(dot(normalize(viewDir), normal), 0.0);
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 2.0);
  }

  // 音声に基づく虹色の生成
  vec3 audioRainbow(float t, float bass, float mid, float treble) {
    // 音の強度をより強調（全体的に抑えめに）
    float intensity = pow((bass + mid + treble) * 0.25, 0.8) * 1.2;
    
    // 各周波数帯域の影響を強調（影響を抑えめに）
    float bassInfluence = pow(bass, 1.2) * 1.5;
    float midInfluence = pow(mid, 1.1) * 1.2;
    float trebleInfluence = pow(treble, 1.3) * 1.3;
    
    // より動的な色相シフト（シフト量を抑えめに）
    float hueShift = bassInfluence * 0.8 + midInfluence * 0.6 + trebleInfluence * 0.4;
    
    // 基本色の生成をより鮮やかに
    float r = sin(t + hueShift) * 0.4 + 0.6;
    float g = sin(t + hueShift + 2.094) * 0.4 + 0.6;
    float b = sin(t + hueShift + 4.189) * 0.4 + 0.6;
    
    // 色の彩度と明度を音の強度に応じて変化（変化を抑えめに）
    vec3 color = vec3(r, g, b);
    color = mix(vec3(0.4), color, intensity * 1.2);  // ベース色をより暗く
    return color * (0.5 + intensity * 0.6);  // 発光を抑えめに
  }

  // 反射光の計算
  vec3 calculateReflection(vec3 normal, vec3 viewDir) {
    vec3 lightPos1 = normalize(vec3(3.0, 3.0, 3.0));
    vec3 lightPos2 = normalize(vec3(-3.0, 3.0, 3.0));
    vec3 lightPos3 = normalize(vec3(0.0, -3.0, 2.0));
    
    vec3 lightColor1 = vec3(1.0, 0.95, 0.9) * 0.6;  // 温かみのある光
    vec3 lightColor2 = vec3(0.9, 0.95, 1.0) * 0.5;  // 冷たい光
    vec3 lightColor3 = vec3(1.0, 1.0, 1.0) * 0.4;   // 下からの光
    
    // 反射ベクトル
    vec3 reflectDir = reflect(-viewDir, normal);
    
    // スペキュラー反射の計算
    float spec1 = pow(max(dot(reflectDir, lightPos1), 0.0), 32.0);
    float spec2 = pow(max(dot(reflectDir, lightPos2), 0.0), 32.0);
    float spec3 = pow(max(dot(reflectDir, lightPos3), 0.0), 32.0);
    
    // 拡散反射の計算
    float diff1 = max(dot(normal, lightPos1), 0.0);
    float diff2 = max(dot(normal, lightPos2), 0.0);
    float diff3 = max(dot(normal, lightPos3), 0.0);
    
    // 反射光の合成
    vec3 reflection = 
      (lightColor1 * (diff1 * 0.5 + spec1 * 0.8)) +
      (lightColor2 * (diff2 * 0.4 + spec2 * 0.7)) +
      (lightColor3 * (diff3 * 0.3 + spec3 * 0.6));
    
    return reflection;
  }

  // RGBシフトエフェクト
  vec3 rgbShift(sampler2D tex, vec2 uv, float intensity) {
    float shift = intensity * 0.03;  // シフト量を3倍に
    vec2 rOffset = vec2(shift, shift * 0.5);  // 赤チャンネルを斜めにシフト
    vec2 gOffset = vec2(-shift * 0.25, -shift * 0.25);  // 緑チャンネルを逆方向に少しシフト
    vec2 bOffset = vec2(-shift * 1.25, shift * 0.5);  // 青チャンネルをより大きくシフト

    float r = texture2D(tex, uv + rOffset).r;
    float g = texture2D(tex, uv + gOffset).g;
    float b = texture2D(tex, uv + bOffset).b;

    // 色の強調
    r = pow(r, 0.9);  // 赤をより強く
    g = pow(g, 1.1);  // 緑を少し抑える
    b = pow(b, 0.95); // 青を少し強める

    return vec3(r, g, b);
  }

  void main() {
    vec4 texColor = texture2D(videoTexture, vUv);
    vec3 normalMapColor = texture2D(normalMap, vUv).xyz * 6.0 - 1.0;
    
    vec3 normal = normalize(vNormal + normalMapColor * 1.0);
    vec3 viewDir = normalize(vViewPosition);
    
    // フレネル効果
    float fresnelTerm = fresnel(viewDir, normal) * 0.4;
    
    // 時間変化する発光色
    float timeOffset = time * 0.3;
    vec3 glowColor = audioRainbow(timeOffset, bassLevel, midLevel, trebleLevel);
    
    // エッジ発光
    float edgeFactor = pow(1.0 - abs(dot(viewDir, normal)), 1.5) * 0.3;
    vec3 edgeGlow = glowColor * edgeFactor;
    
    // 外部からの反射光を計算
    vec3 reflection = calculateReflection(normal, viewDir);

    // RGBシフトを適用
    vec3 shiftedColor = rgbShift(videoTexture, vUv, glitchIntensity);
    
    // カラーの合成
    vec3 baseColor = mix(shiftedColor, glowColor + edgeGlow + reflection * 0.5, fresnelTerm);
    vec3 finalColor = mix(
      baseColor,
      baseColor + glowColor * glitchIntensity,  // グロー効果を元の値に戻す
      glitchIntensity * 0.5  // ミックス比率を元の値に戻す
    );
    
    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

function StoneModel({ videoTexture, audioData, isMobile }: { 
  videoTexture: THREE.VideoTexture,
  audioData: {
    audioLevel: number;
    bassLevel: number;
    midLevel: number;
    trebleLevel: number;
  },
  isMobile: boolean;
}) {
  const { scene } = useGLTF('/stone 03 _ CC0 usage.glb');
  const innerLightRef = useRef<THREE.PointLight>(null);
  const shaderRef = useRef<THREE.ShaderMaterial | null>(null) as MutableRefObject<THREE.ShaderMaterial | null>;
  const groupRef = useRef<THREE.Group>(null);
  const currentTime = useRef(0);
  
  // デフォルトの位置を保持
  const defaultPosition = useMemo(() => new THREE.Vector3(0, isMobile ? 0.5 : 0, 0), [isMobile]);
  
  // クリックアニメーションの状態
  const clickAnimation = useRef({
    isAnimating: false,
    startTime: 0,
    duration: 300,
    originalPosition: defaultPosition.clone(),
    targetPosition: new THREE.Vector3(0, 0, 0),
    glitchIntensity: 0,
  });
  
  // 回転の状態を保持
  const rotationState = useRef({
    time: 0,
    baseSpeed: {
      x: 0.001 + Math.random() * 0.0008,
      y: 0.0015 + Math.random() * 0.001,
      z: 0.0008 + Math.random() * 0.0006
    },
    wobblePhase: {
      x: Math.random() * Math.PI * 2,
      y: Math.random() * Math.PI * 2,
      z: Math.random() * Math.PI * 2
    }
  });

  // ランダムな方向を生成する関数
  const generateRandomDirection = () => {
    const angle = Math.random() * Math.PI * 2;
    const upwardBias = Math.random() * 0.015;
    const direction = new THREE.Vector3(
      Math.cos(angle) * 0.06,
      Math.sin(angle) * 0.045 + upwardBias,
      Math.sin(angle) * 0.06
    ).normalize().multiplyScalar(0.09);
    
    // デフォルトの位置を基準に新しい位置を計算
    return direction.add(defaultPosition);
  };

  useFrame(({ clock }) => {
    currentTime.current = clock.getElapsedTime() * 1000;
    
    if (innerLightRef.current) {
      const time = clock.getElapsedTime();
      innerLightRef.current.intensity = 2.0 + Math.sin(time * 2) * 0.5;

      if (shaderRef.current) {
        shaderRef.current.uniforms.time.value = time;
        shaderRef.current.uniforms.audioLevel.value = audioData.audioLevel;
        shaderRef.current.uniforms.bassLevel.value = audioData.bassLevel;
        shaderRef.current.uniforms.midLevel.value = audioData.midLevel;
        shaderRef.current.uniforms.trebleLevel.value = audioData.trebleLevel;
      }
    }

    // グループの回転と位置を更新
    if (groupRef.current) {
      const time = clock.getElapsedTime();
      rotationState.current.time = time;

      // 基本回転速度に揺らぎを加える
      const wobbleX = Math.sin(time * 0.3 + rotationState.current.wobblePhase.x) * 0.005;
      const wobbleY = Math.sin(time * 0.4 + rotationState.current.wobblePhase.y) * 0.003;
      const wobbleZ = Math.sin(time * 0.2 + rotationState.current.wobblePhase.z) * 0.005;

      // 各軸の回転を更新
      groupRef.current.rotation.x += rotationState.current.baseSpeed.x + wobbleX;
      groupRef.current.rotation.y += rotationState.current.baseSpeed.y + wobbleY;
      groupRef.current.rotation.z += rotationState.current.baseSpeed.z + wobbleZ;

      // 音声の強度に応じて回転速度を微調整
      const audioInfluence = audioData.audioLevel * 0.04;
      groupRef.current.rotation.y += audioInfluence;

      // クリックアニメーションの更新
      if (clickAnimation.current.isAnimating && groupRef.current) {
        const elapsed = currentTime.current - clickAnimation.current.startTime;
        const progress = Math.min(elapsed / clickAnimation.current.duration, 1);
        
        const easeOutQuart = (x: number): number => {
          return 1 - Math.pow(1 - x, 4);
        };

        const bounceProgress = progress < 0.3
          ? progress * 3.3
          : 1 - (progress - 0.3) * 1.43;
        
        const glitchProgress = progress < 0.5
          ? progress * 3.0
          : Math.max(0, 1 - (progress - 0.5) * 2.0);
        clickAnimation.current.glitchIntensity = easeOutQuart(glitchProgress) * 1.5;

        if (shaderRef.current) {
          shaderRef.current.uniforms.glitchIntensity.value = clickAnimation.current.glitchIntensity;
        }

        const currentPosition = new THREE.Vector3().lerpVectors(
          clickAnimation.current.originalPosition,
          clickAnimation.current.targetPosition,
          easeOutQuart(bounceProgress)
        );

        groupRef.current.position.copy(currentPosition);

        if (progress >= 1) {
          clickAnimation.current.isAnimating = false;
          // アニメーション終了時にデフォルトの位置に戻す
          groupRef.current.position.copy(defaultPosition);
          clickAnimation.current.originalPosition.copy(defaultPosition);
          if (shaderRef.current) {
            shaderRef.current.uniforms.glitchIntensity.value = 0;
          }
        }
      }
    }
  });

  // クリックハンドラー
  const handleClick = () => {
    if (!clickAnimation.current.isAnimating && groupRef.current) {
      clickAnimation.current.isAnimating = true;
      clickAnimation.current.startTime = currentTime.current;
      clickAnimation.current.originalPosition.copy(groupRef.current.position);
      clickAnimation.current.targetPosition = generateRandomDirection();
    }
  };

  scene.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) {
      const mesh = object as THREE.Mesh;
      const originalMaterial = mesh.material as THREE.MeshStandardMaterial;
      // スマートフォンでの表示サイズを調整（1.5から1.8に変更）
      const scale = isMobile ? 1.8 : 2;
      mesh.scale.set(scale, scale, scale);
      // メッシュの位置はリセット（グループで制御）
      mesh.position.set(0, 0, 0);
      
      const originalNormalMap = originalMaterial.normalMap;
      
      const shaderMaterial = new THREE.ShaderMaterial({
        uniforms: {
          videoTexture: { value: videoTexture },
          normalMap: { value: originalNormalMap },
          time: { value: 0.0 },
          audioLevel: { value: 0.0 },
          bassLevel: { value: 0.0 },
          midLevel: { value: 0.0 },
          trebleLevel: { value: 0.0 },
          glitchIntensity: { value: 0.0 } // グリッチ強度のuniformを追加
        },
        vertexShader,
        fragmentShader,
        transparent: false,
        side: THREE.DoubleSide,
      });
      
      shaderRef.current = shaderMaterial;
      mesh.material = shaderMaterial;
    }
  });

  return (
    <group 
      ref={groupRef}
      onClick={handleClick}
      onPointerOver={() => document.body.style.cursor = 'pointer'}
      onPointerOut={() => document.body.style.cursor = 'auto'}
      position={[0, isMobile ? 0.3 : 0, 0]}
    >
      <primitive object={scene} />
      <pointLight
        ref={innerLightRef}
        position={[0, 0, 2]}
        intensity={3.0}
        distance={10}
        decay={2}
      />
      <pointLight
        position={[0, 0, -3]}
        intensity={3.0}
        distance={12}
        decay={2}
        color="#ffffff"
      />
    </group>
  );
}

function Scene() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoTexture, setVideoTexture] = useState<THREE.VideoTexture | null>(null);
  const [audioData, setAudioData] = useState({
    audioLevel: 0,
    bassLevel: 0,
    midLevel: 0,
    trebleLevel: 0
  });
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    
    // 初期チェック
    checkMobile();
    
    // リサイズイベントのリスナーを追加
    window.addEventListener('resize', checkMobile);
    
    // クリーンアップ
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    let mounted = true;
    let animationFrameId: number;

    async function setupAudioAnalysis(stream: MediaStream) {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext();
        analyserRef.current = audioContextRef.current.createAnalyser();
        analyserRef.current.fftSize = 2048;
        analyserRef.current.smoothingTimeConstant = 0.5;  // 値を0.8から0.5に変更してより敏感に
        
        sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
        sourceRef.current.connect(analyserRef.current);
      }

      const analyser = analyserRef.current;
      if (!analyser) return;  // null チェックを追加

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      function analyzeAudio() {
        if (!mounted || !analyser) return;  // null チェックを追加

        analyser.getByteFrequencyData(dataArray);
        
        // 周波数帯域の分割をより詳細に
        const bassRange = dataArray.slice(0, 30);    // 低音域を拡大
        const midRange = dataArray.slice(30, 150);   // 中音域を拡大
        const trebleRange = dataArray.slice(150, 300); // 高音域を拡大

        // 感度を上げるために係数を調整
        const bassLevel = Math.pow(bassRange.reduce((a, b) => a + b, 0) / bassRange.length / 255, 0.8);
        const midLevel = Math.pow(midRange.reduce((a, b) => a + b, 0) / midRange.length / 255, 0.8);
        const trebleLevel = Math.pow(trebleRange.reduce((a, b) => a + b, 0) / trebleRange.length / 255, 0.8);
        const audioLevel = (bassLevel + midLevel + trebleLevel) / 3;

        setAudioData({
          audioLevel: Math.min(audioLevel * 1.5, 1.0),  // 全体の感度を上げる
          bassLevel: Math.min(bassLevel * 1.8, 1.0),    // 低音の感度を上げる
          midLevel: Math.min(midLevel * 1.6, 1.0),      // 中音の感度を上げる
          trebleLevel: Math.min(trebleLevel * 1.7, 1.0) // 高音の感度を上げる
        });

        animationFrameId = requestAnimationFrame(analyzeAudio);
      }

      analyzeAudio();
    }

    async function setupVideo() {
      try {
        videoRef.current = document.createElement('video');
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: true,
          audio: true 
        });
        
        if (!mounted) return;
        
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          
          const texture = new THREE.VideoTexture(videoRef.current);
          texture.colorSpace = THREE.SRGBColorSpace;
          setVideoTexture(texture);

          await setupAudioAnalysis(stream);
        }
      } catch (error) {
        console.error('Error setting up video or audio:', error);
      }
    }

    setupVideo();

    return () => {
      mounted = false;
      cancelAnimationFrame(animationFrameId);
      if (sourceRef.current) {
        sourceRef.current.disconnect();
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      if (videoRef.current) {
        const stream = videoRef.current.srcObject as MediaStream;
        if (stream) {
          stream.getTracks().forEach(track => track.stop());
        }
      }
    };
  }, []);

  return (
    <Canvas 
      camera={{ 
        position: [0, 0, isMobile ? 5.5 : 5], 
        fov: isMobile ? 50 : 45 
      }}
      shadows
      gl={{ 
        alpha: false,
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.5
      }}
      style={{ background: '#1a1a1a' }}
    >
      <Suspense fallback={null}>
        <ambientLight intensity={1.5} />
        <directionalLight 
          position={[3, 3, 3]}
          intensity={4.0}
          castShadow
          color="#ffedcc"
        />
        <directionalLight 
          position={[-3, 3, 3]}
          intensity={3.5}
          castShadow
          color="#cce0ff"
        />
        <spotLight
          position={[0, -3, 2]}
          intensity={2.0}
          angle={0.5}
          penumbra={0.5}
          distance={10}
          color="#ffffff"
        />
        <Environment preset="studio" />
        {videoTexture && (
          <StoneModel 
            videoTexture={videoTexture} 
            audioData={audioData}
            isMobile={isMobile}
          />
        )}
        <EffectComposer>
          <Bloom 
            intensity={2.0}
            luminanceThreshold={0.2}
            luminanceSmoothing={0.9}
            mipmapBlur
            radius={0.8}
          />
          <Noise 
            premultiply
            blendFunction={BlendFunction.SOFT_LIGHT}
            opacity={0.5}
          />
        </EffectComposer>
      </Suspense>
      <OrbitControls 
        minDistance={3}
        maxDistance={10}
      />
    </Canvas>
  );
}

export default function Home() {
  const [showPermissionDialog, setShowPermissionDialog] = useState(true);

  return (
    <div className="w-screen h-screen relative">
      {showPermissionDialog && (
        <div className="absolute top-0 left-0 w-full h-full bg-black bg-opacity-80 flex items-center justify-center z-50">
          <div className="bg-gray-800 p-8 rounded-lg max-w-md mx-4 text-center">
            <h2 className="text-xl mb-8">カメラとマイクの使用について</h2>
            <p className="text-xs mb-12">
              この作品では、カメラとマイクを使用して、周囲の映像と音に反応するインタラクティブな体験を提供します。
            </p>
            <button
              onClick={() => setShowPermissionDialog(false)}
              className="text-white px-6 py-3 rounded-full hover:bg-gray-400 transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}
      
      <Link
        href="/about"
        className="absolute top-4 right-4 z-10 px-6 py-2 bg-black bg-opacity-20 backdrop-blur-md rounded-full text-white hover:bg-gray-800 transition-all"
      >
        About
      </Link>

      <main className="w-full h-full">
        <Scene />
      </main>
    </div>
  );
}
