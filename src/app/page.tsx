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
  uniform float glitchIntensity;
  uniform float opacity;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;

  // コントラスト調整関数を追加
  vec3 adjustContrast(vec3 color, float contrast) {
    const vec3 midpoint = vec3(0.5, 0.5, 0.5);
    return midpoint + (color - midpoint) * (1.0 + contrast);
  }

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
    
    // 各周波数帯域の影響を個別に計算
    float bassInfluence = pow(bass, 1.2) * 1.5;
    float midInfluence = pow(mid, 1.1) * 1.2;
    float trebleInfluence = pow(treble, 1.3) * 1.3;
    
    // より動的な色相シフト
    float hueShift = bassInfluence * 0.8 + midInfluence * 0.6 + trebleInfluence * 0.4;
    
    // 基本色の生成をより複雑に
    float r = sin(t + hueShift) * 0.5 + 0.5;
    float g = sin(t + hueShift + 2.094 + midInfluence * 0.3) * 0.5 + 0.5;
    float b = sin(t + hueShift + 4.189 + trebleInfluence * 0.3) * 0.5 + 0.5;
    
    // 中間色の生成
    float r2 = sin(t * 0.7 + hueShift) * 0.5 + 0.5;
    float g2 = sin(t * 0.7 + hueShift + 2.094) * 0.5 + 0.5;
    float b2 = sin(t * 0.7 + hueShift + 4.189) * 0.5 + 0.5;
    
    // 色のブレンド
    vec3 color1 = vec3(r, g, b);
    vec3 color2 = vec3(r2, g2, b2);
    vec3 blendedColor = mix(color1, color2, bassInfluence * 0.5);
    
    // 色の彩度と明度を音の強度に応じて変化
    vec3 finalColor = mix(vec3(0.4), blendedColor, intensity * 1.2);
    
    // 低音の強さに応じて暖色を強調
    finalColor.r += bassInfluence * 0.2;
    // 中音の強さに応じて緑を調整
    finalColor.g += midInfluence * 0.15;
    // 高音の強さに応じて青を調整
    finalColor.b += trebleInfluence * 0.1;
    
    // 最終的な色の調整
    return finalColor * (0.5 + intensity * 0.6);
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
    
    // カントラストを控えめに調整
    shiftedColor = adjustContrast(shiftedColor, 0.5);
    
    // カラーの合成
    vec3 baseColor = mix(shiftedColor, glowColor + edgeGlow + reflection * 0.5, fresnelTerm);
    vec3 finalColor = mix(
      baseColor,
      baseColor + glowColor * glitchIntensity,
      glitchIntensity * 0.5
    );
    
    // 最終的なカラーのコントラストも控えめに
    finalColor = adjustContrast(finalColor, 0.1);
    
    gl_FragColor = vec4(finalColor, opacity);
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
  const defaultPosition = useMemo(() => {
    const pos = new THREE.Vector3(0, isMobile ? 0.3 : 0, 0);
    return pos;
  }, [isMobile]);
  
  // クリックアニメーションの状態
  const clickAnimation = useRef({
    isAnimating: false,
    startTime: 0,
    duration: 500,
    originalPosition: defaultPosition.clone(),
    targetPosition: defaultPosition.clone(),
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

  // 出現アニメーションの状態
  const appearanceAnimation = useRef({
    started: false,
    startTime: 0,
    duration: 3000,
    fadeInDelay: 1000, // フェードインの開始を1秒遅らせる
  });

  // スケールとopacityのアニメーション状態
  const [scale, setScale] = useState(0.001);
  const [opacity, setOpacity] = useState(0);
  const targetScale = useMemo(() => isMobile ? 1.8 : 2, [isMobile]);

  // アニメーションフレームの参照を保持
  const frameRef = useRef<number>();
  
  // コンポーネントのマウント状態を追跡
  const mountedRef = useRef(true);

  useEffect(() => {
    appearanceAnimation.current.started = true;
    appearanceAnimation.current.startTime = Date.now();

    const currentFrame = frameRef.current;

    return () => {
      mountedRef.current = false;
      if (currentFrame) {
        cancelAnimationFrame(currentFrame);
      }
    };
  }, []);

  // ランダムな方向を生成する関数
  const generateRandomDirection = () => {
    const angle = Math.random() * Math.PI * 2;
    const upwardBias = Math.random() * 0.015;
    
    // デフォルトの位置を基準にオフセットを計算
    const offset = new THREE.Vector3(
      Math.cos(angle) * 0.06,
      Math.sin(angle) * 0.045 + upwardBias,
      Math.sin(angle) * 0.06
    ).normalize().multiplyScalar(0.09);
    
    // デフォルトの位置にオフセットを加算
    return defaultPosition.clone().add(offset);
  };

  // デフォルト位置の更新を監視
  useEffect(() => {
    if (groupRef.current) {
      groupRef.current.position.copy(defaultPosition);
      clickAnimation.current.originalPosition.copy(defaultPosition);
      clickAnimation.current.targetPosition.copy(defaultPosition);
    }
  }, [defaultPosition]);

  useFrame(({ clock }) => {
    if (!mountedRef.current) return;

    currentTime.current = clock.getElapsedTime() * 1000;
    
    if (innerLightRef.current) {
      const time = clock.getElapsedTime();
      // 内部ライトの強度を音声レベルに応じて調整（最大強度を上げる）
      const minIntensity = 0.5;
      const maxIntensity = 4.0; // 2.5から4.0に上げる
      const audioBasedIntensity = minIntensity + (maxIntensity - minIntensity) * audioData.audioLevel;
      innerLightRef.current.intensity = audioBasedIntensity + Math.sin(time * 2) * 0.3;

      if (shaderRef.current) {
        shaderRef.current.uniforms.time.value = time;
        // 音声レベルの影響を調整（より強い反応に）
        shaderRef.current.uniforms.audioLevel.value = Math.pow(audioData.audioLevel, 0.6); // 0.7から0.6に下げてより反応しやすく
        shaderRef.current.uniforms.bassLevel.value = Math.pow(audioData.bassLevel, 0.6);
        shaderRef.current.uniforms.midLevel.value = Math.pow(audioData.midLevel, 0.6);
        shaderRef.current.uniforms.trebleLevel.value = Math.pow(audioData.trebleLevel, 0.6);
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

      // 音声の強度に応じて回転速度を微調整（影響を強める）
      const audioInfluence = audioData.audioLevel * 0.08;  // 0.04から0.08に上げる
      groupRef.current.rotation.y += audioInfluence;
      groupRef.current.rotation.x += audioInfluence * 0.5;  // X軸にも回転を追加

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
          groupRef.current.position.copy(defaultPosition);
          clickAnimation.current.originalPosition.copy(defaultPosition);
          clickAnimation.current.targetPosition.copy(defaultPosition);
          if (shaderRef.current) {
            shaderRef.current.uniforms.glitchIntensity.value = 0;
          }
        }
      }
    }

    // 出現アニメーションの更新
    if (appearanceAnimation.current.started) {
      const elapsed = Date.now() - appearanceAnimation.current.startTime;
      const delayedElapsed = Math.max(0, elapsed - appearanceAnimation.current.fadeInDelay);
      const progress = Math.min(elapsed / appearanceAnimation.current.duration, 1);
      const fadeProgress = Math.min(delayedElapsed / (appearanceAnimation.current.duration - appearanceAnimation.current.fadeInDelay), 1);
      
      if (mountedRef.current) {
        const easeOutCubic = (x: number): number => {
          return 1 - Math.pow(1 - x, 3);
        };
        
        const currentScale = 0.001 + (targetScale - 0.001) * easeOutCubic(progress);
        const currentOpacity = easeOutCubic(fadeProgress);
        
        setScale(currentScale);
        setOpacity(currentOpacity);
        
        if (progress >= 1) {
          appearanceAnimation.current.started = false;
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
      mesh.scale.set(scale, scale, scale);
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
          glitchIntensity: { value: 0.0 },
          opacity: { value: opacity }
        },
        vertexShader,
        fragmentShader: fragmentShader.replace(
          'gl_FragColor = vec4(finalColor, 1.0);',
          'gl_FragColor = vec4(finalColor, opacity);'
        ),
        transparent: true,
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
      position={defaultPosition.clone()}
    >
      <primitive object={scene} />
      <pointLight
        ref={innerLightRef}
        position={[0, 0, 2]}
        intensity={0.3}
        distance={10}
        decay={2}
      />
      <pointLight
        position={[0, 0, -3]}
        intensity={1.5}
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
  const animationFrameRef = useRef<number>();
  const [isMobile, setIsMobile] = useState(false);
  const [fogDensity, setFogDensity] = useState(0.2);

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

    async function setupAudioAnalysis(stream: MediaStream) {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext();
        analyserRef.current = audioContextRef.current.createAnalyser();
        analyserRef.current.fftSize = 2048;
        analyserRef.current.smoothingTimeConstant = 0.5;
        
        sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
        sourceRef.current.connect(analyserRef.current);
      }

      const analyser = analyserRef.current;
      if (!analyser) return;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      function analyzeAudio() {
        if (!mounted || !analyser) return;

        analyser.getByteFrequencyData(dataArray);
        
        // 周波数帯域の分割をより詳細に
        const bassRange = dataArray.slice(0, 30);
        const midRange = dataArray.slice(30, 150);
        const trebleRange = dataArray.slice(150, 300);

        // 感度を上げるために係数を調整
        const bassLevel = Math.pow(bassRange.reduce((a, b) => a + b, 0) / bassRange.length / 255, 0.8);
        const midLevel = Math.pow(midRange.reduce((a, b) => a + b, 0) / midRange.length / 255, 0.8);
        const trebleLevel = Math.pow(trebleRange.reduce((a, b) => a + b, 0) / trebleRange.length / 255, 0.8);
        const audioLevel = (bassLevel + midLevel + trebleLevel) / 3;

        setAudioData({
          audioLevel: Math.min(audioLevel * 1.5, 1.0),
          bassLevel: Math.min(bassLevel * 1.8, 1.0),
          midLevel: Math.min(midLevel * 1.6, 1.0),
          trebleLevel: Math.min(trebleLevel * 1.7, 1.0)
        });

        animationFrameRef.current = requestAnimationFrame(analyzeAudio);
      }

      analyzeAudio();
    }

    async function setupVideo() {
      try {
        videoRef.current = document.createElement('video');
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        
        const constraints = {
          video: isMobile ? {
            facingMode: { exact: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          } : {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: true 
        };
        
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        if (!mounted) return;
        
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          
          if (!mounted) return;

          const texture = new THREE.VideoTexture(videoRef.current);
          texture.colorSpace = THREE.SRGBColorSpace;
          setVideoTexture(texture);

          await setupAudioAnalysis(stream);
        }
      } catch (error) {
        if (!mounted) return;
        console.error('Error setting up video or audio:', error);
        // フォールバック: 背面カメラが使用できない場合はフロントカメラを試す
        if (isMobile) {
          try {
            const fallbackStream = await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: 'user',
                width: { ideal: 1280 },
                height: { ideal: 720 }
              },
              audio: true
            });
            
            if (!mounted) return;
            
            if (videoRef.current) {
              videoRef.current.srcObject = fallbackStream;
              await videoRef.current.play();
              
              const texture = new THREE.VideoTexture(videoRef.current);
              texture.colorSpace = THREE.SRGBColorSpace;
              setVideoTexture(texture);

              await setupAudioAnalysis(fallbackStream);
            }
          } catch (fallbackError) {
            console.error('Error setting up fallback camera:', fallbackError);
          }
        }
      }
    }

    setupVideo();

    // フォグのタイマー
    const fogTimer = setTimeout(() => {
      if (mounted) setFogDensity(0);
    }, 4000);

    return () => {
      mounted = false;
      clearTimeout(fogTimer);
      
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      
      if (videoRef.current) {
        const stream = videoRef.current.srcObject as MediaStream;
        if (stream) {
          stream.getTracks().forEach(track => track.stop());
        }
      }
      
      if (sourceRef.current) {
        sourceRef.current.disconnect();
      }
      
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, [isMobile]);

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
        toneMappingExposure: 1.2
      }}
      style={{ background: '#1a1a1a' }}
    >
      <Suspense fallback={null}>
        <fog attach="fog" args={['#1a1a1a', 0, fogDensity > 0 ? 8 : 30]} />
        <ambientLight intensity={0.8} />
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
            intensity={2.2}  // 3.0から2.2に下げる
            luminanceThreshold={0.25}  // 0.2から0.25に上げて発光を抑える
            luminanceSmoothing={0.9}
            mipmapBlur
            radius={0.8}
          />
          <Noise 
            premultiply
            blendFunction={BlendFunction.SOFT_LIGHT}
            opacity={0.4}
          />
        </EffectComposer>
      </Suspense>
      <OrbitControls 
        minDistance={3}
        maxDistance={10}
        enableZoom={false}
        enablePan={false}
        touches={{
          ONE: THREE.TOUCH.ROTATE
        }}
      />
    </Canvas>
  );
}

export default function Home() {
  return (
    <div className="w-screen h-screen relative">
      <Link
        href="/about"
        className="absolute top-4 right-4 z-10 px-6 py-2 bg-black bg-opacity-20 backdrop-blur-md rounded-full text-white hover:bg-gray-800 transition-all"
      >
        詳細
      </Link>
      <p className="absolute bottom-4 left-4 z-10 text-white text-xs tracking-wider">
        純粋な石 | 2024.12.31 johnny.soga
      </p>

      <main className="w-full h-full">
        <Scene />
      </main>
    </div>
  );
}
