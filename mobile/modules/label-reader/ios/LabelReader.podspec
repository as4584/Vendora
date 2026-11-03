Pod::Spec.new do |s|
  s.name           = 'LabelReader'
  s.version        = '1.0.0'
  s.summary        = 'On-device box label text recognition for Vendora smart scan'
  s.description    = 'Reads printed text from a photo with Apple Vision. Runs fully on device.'
  s.author         = 'Vendora'
  s.homepage       = 'https://vendora.lexmakesit.com'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Vision', 'VisionKit', 'UIKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
  s.source_files = '**/*.{h,m,swift}'
end
