#!/bin/zsh

set -e

# Xcode Cloud runs this script after cloning the repository

echo "Installing Homebrew dependencies..."
brew install node

echo "Installing Node.js dependencies..."
cd "$CI_PRIMARY_REPOSITORY_PATH/apps/mobile"
npm install

echo "Installing CocoaPods dependencies..."
cd "$CI_PRIMARY_REPOSITORY_PATH/apps/mobile/ios"

rm -f Podfile.lock

pod install --repo-update

echo "Dependencies installed successfully"
