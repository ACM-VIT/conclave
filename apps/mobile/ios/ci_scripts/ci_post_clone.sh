#!/bin/zsh

set -e

# Xcode Cloud runs this script after cloning the repository

echo "Installing Homebrew dependencies..."
export HOMEBREW_NO_AUTO_UPDATE=1
brew install node@22
export PATH="$(brew --prefix node@22)/bin:$PATH"

echo "Node version:"
node -v
echo "npm version:"
npm -v

echo "Writing .env from Xcode Cloud environment variables..."
cat > "$CI_PRIMARY_REPOSITORY_PATH/apps/mobile/.env" << EOF
EXPO_PUBLIC_SFU_BASE_URL=${EXPO_PUBLIC_SFU_BASE_URL}
EXPO_PUBLIC_SFU_CLIENT_ID=${EXPO_PUBLIC_SFU_CLIENT_ID}
EXPO_PUBLIC_API_URL=${EXPO_PUBLIC_API_URL}
EXPO_PUBLIC_APP_URL=${EXPO_PUBLIC_APP_URL}
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=${EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID}
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=${EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID}
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=${EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID}
EOF

echo "Installing Node.js dependencies..."
cd "$CI_PRIMARY_REPOSITORY_PATH/apps/mobile"
npm ci

echo "Installing CocoaPods dependencies..."
cd "$CI_PRIMARY_REPOSITORY_PATH/apps/mobile/ios"

rm -f Podfile.lock

pod install --repo-update

echo "Dependencies installed successfully"
