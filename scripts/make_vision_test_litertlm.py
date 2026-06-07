"""
Create a minimal synthetic .litertlm with dummy vision encoder/adapter sections.
Used to test whether the CDN @litert-lm/core WASM's vision runner path is reachable.

The TFLite bytes are invalid (zeros) — the test captures the FIRST error:
  - "LlmVisionInferenceCalculator not registered" → calculator missing (#2150)
  - "Failed to build TFLite model from buffer" → calculator present, TFLite invalid (expected)
  - Any other error → investigate

Usage:
  /home/jun/litert-venv/bin/python make_vision_test_litertlm.py [output_path]
"""
import os
import sys
import tempfile

# litert-venv has litert_lm_builder 0.13.0
VENV = '/home/jun/litert-venv'
SP = os.path.join(VENV, 'lib/python3.12/site-packages')
if SP not in sys.path:
    sys.path.insert(0, SP)

from litert_lm_builder.litertlm_builder import LitertLmFileBuilder, TfLiteModelType

output_path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/vision_test.litertlm'
os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else '.', exist_ok=True)

# Minimal LlmMetadata: empty proto3 binary (all fields optional → IsInitialized() passes)
meta_fd, meta_path = tempfile.mkstemp(suffix='.pb')
os.close(meta_fd)
with open(meta_path, 'wb') as f:
    f.write(b'')  # proto3: empty = all defaults, IsInitialized() = True

# Tiny dummy TFLite sections: 64 bytes of zeros.
# WASM will fail at tflite::FlatBufferModel::BuildFromBuffer (expected).
# The IMPORTANT thing is: does the vision runner get instantiated BEFORE this failure?
enc_fd, enc_path = tempfile.mkstemp(suffix='.tflite')
os.close(enc_fd)
with open(enc_path, 'wb') as f:
    f.write(bytes(64))

ada_fd, ada_path = tempfile.mkstemp(suffix='.tflite')
os.close(ada_fd)
with open(ada_path, 'wb') as f:
    f.write(bytes(64))

builder = LitertLmFileBuilder()
builder.add_llm_metadata(meta_path)
builder.add_tflite_model(enc_path, TfLiteModelType.VISION_ENCODER)
builder.add_tflite_model(ada_path, TfLiteModelType.VISION_ADAPTER)

with open(output_path, 'wb') as f:
    builder.build(f)

size = os.path.getsize(output_path)
print(f'Created: {output_path}  ({size} bytes / {size//1024} KB)')

# Cleanup temps
for p in [meta_path, enc_path, ada_path]:
    os.unlink(p)
