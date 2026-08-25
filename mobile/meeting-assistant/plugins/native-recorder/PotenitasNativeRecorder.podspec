Pod::Spec.new do |s|
  s.name = 'PotenitasNativeRecorder'
  s.version = '0.1.0'
  s.summary = 'Meeting Assistant native On-site recorder'
  s.license = 'UNLICENSED'
  s.homepage = 'https://tsam-ai.com/meeting-assistant/'
  s.author = 'Potenitas'
  s.source = { :git => 'https://github.com/potenitas/meeting-assistant.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
end
