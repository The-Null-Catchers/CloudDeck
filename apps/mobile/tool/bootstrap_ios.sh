#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if ! command -v flutter >/dev/null 2>&1; then
  echo "Flutter is required to generate the iOS runner." >&2
  exit 1
fi

if [ ! -d ios ]; then
  flutter create \
    --platforms=ios \
    --org org.clouddeck \
    --project-name clouddeck_mobile \
    --no-pub \
    .
fi

# flutter create may add editor metadata and the sample counter test.
rm -f test/widget_test.dart
rm -rf .idea clouddeck_mobile.iml

PBXPROJ=ios/Runner.xcodeproj/project.pbxproj
if [ ! -f "$PBXPROJ" ]; then
  echo "Generated iOS Xcode project is missing." >&2
  exit 1
fi

python3 - "$PBXPROJ" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text()
text = re.sub(
    r'PRODUCT_BUNDLE_IDENTIFIER = [^;]+;',
    'PRODUCT_BUNDLE_IDENTIFIER = org.clouddeck.mobile;',
    text,
)
path.write_text(text)
PY

PLIST=ios/Runner/Info.plist
if [ ! -f "$PLIST" ]; then
  echo "Generated iOS Info.plist is missing." >&2
  exit 1
fi

python3 - "$PLIST" <<'PY'
from pathlib import Path
import plistlib
import sys

path = Path(sys.argv[1])
with path.open('rb') as fh:
    data = plistlib.load(fh)
data['CFBundleDisplayName'] = 'CloudDeck'
data['CFBundleName'] = 'CloudDeck'
with path.open('wb') as fh:
    plistlib.dump(data, fh, sort_keys=False)
PY

printf '%s\n' "iOS runner ready at $ROOT/ios"
