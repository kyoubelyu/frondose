{
  "targets": [{
    "target_name": "cgevent",
    "sources": ["native/cgevent/cgevent.cc"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
    "conditions": [
      ["OS=='mac'", {
        "xcode_settings": { "MACOSX_DEPLOYMENT_TARGET": "11.0" },
        "libraries": [
          "-framework ApplicationServices",
          "-framework CoreFoundation",
          "-framework Carbon"
        ]
      }]
    ]
  }]
}
