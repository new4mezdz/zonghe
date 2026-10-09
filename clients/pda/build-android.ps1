[CmdletBinding()]
param(
    [string]$SdkRoot = (Join-Path $env:LOCALAPPDATA 'WarehousePda\toolchain'),
    [string]$JdkRoot = $env:JAVA_HOME,
    [string]$BuildRoot = (Join-Path $env:TEMP 'warehouse-pda-android'),
    [string]$KeyStore = '',
    [string]$KeyAlias = 'warehouse-pda-test',
    [switch]$InstallToolchain
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
# This client can live inside a larger repository. Keep SDK, signing material,
# and intermediate files outside that whole checkout, not just this subfolder.
$workspaceRoot = $projectRoot
$candidateDirectory = Get-Item -LiteralPath $projectRoot
while ($null -ne $candidateDirectory) {
    if (Test-Path -LiteralPath (Join-Path $candidateDirectory.FullName '.git')) {
        $workspaceRoot = $candidateDirectory.FullName
        break
    }
    $candidateDirectory = $candidateDirectory.Parent
}
$buildToolsVersion = '30.0.3'
$compileSdkVersion = '30'

function Assert-ExternalPath([string]$Path, [string]$Label) {
    $absolutePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    $projectPrefix = $workspaceRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if ($absolutePath.Equals($workspaceRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $absolutePath.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must be outside the repository directory: $absolutePath"
    }
    return $absolutePath
}

function Invoke-BuildTool([string]$Tool, [string[]]$Arguments) {
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Build tool failed with exit code ${LASTEXITCODE}: $Tool" }
}

function Install-PinnedPackage([string]$ArchiveName, [string]$Checksum, [string]$Target) {
    $downloadDirectory = Join-Path $SdkRoot 'downloads'
    $unpackDirectory = Join-Path $SdkRoot ('unpack-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $downloadDirectory, $unpackDirectory -Force | Out-Null
    $archivePath = Join-Path $downloadDirectory $ArchiveName
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
        Invoke-WebRequest -Uri ('https://dl.google.com/android/repository/' + $ArchiveName) -OutFile $archivePath
    }
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA1).Hash -ne $Checksum) {
        throw "Android SDK archive checksum mismatch. Remove this file and retry: $archivePath"
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $unpackDirectory
    $packageDirectories = @(Get-ChildItem -LiteralPath $unpackDirectory -Directory)
    if ($packageDirectories.Count -ne 1) { throw "Unexpected SDK archive layout: $archivePath" }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
    # Both fully resolved paths are checked before moving an extracted directory.
    $safeSource = Assert-ExternalPath $packageDirectories[0].FullName 'SDK extraction'
    $safeTarget = Assert-ExternalPath $Target 'SDK destination'
    $sdkPrefix = $SdkRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $safeSource.StartsWith($sdkPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not $safeTarget.StartsWith($sdkPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'SDK package paths must remain inside SdkRoot.'
    }
    Move-Item -LiteralPath $safeSource -Destination $safeTarget
}

$SdkRoot = Assert-ExternalPath $SdkRoot 'SdkRoot'
$BuildRoot = Assert-ExternalPath $BuildRoot 'BuildRoot'
$buildTools = Join-Path $SdkRoot ('build-tools\' + $buildToolsVersion)
$platformRoot = Join-Path $SdkRoot ('platforms\android-' + $compileSdkVersion)
if ($InstallToolchain) {
    # Versions and checksums are pinned to Google's Android repository metadata.
    if (-not (Test-Path -LiteralPath $buildTools -PathType Container)) {
        Install-PinnedPackage `
            '91936d4ee3ccc839f0addd53c9ebf087b1e39251.build-tools_r30.0.3-windows.zip' `
            'fc165c721b8d2da55e6fede467526c81f562be7b' $buildTools
    }
    if (-not (Test-Path -LiteralPath $platformRoot -PathType Container)) {
        Install-PinnedPackage 'platform-30_r03.zip' 'e7c6280901dcfa511af098d67dd88c4dfcbc6ea2' $platformRoot
    }
}

$androidJar = Join-Path $platformRoot 'android.jar'
$aapt2 = Join-Path $buildTools 'aapt2.exe'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$d8Jar = Join-Path $buildTools 'lib\d8.jar'
$signerJar = Join-Path $buildTools 'lib\apksigner.jar'
$lambdaStubs = Join-Path $buildTools 'core-lambda-stubs.jar'
foreach ($requiredFile in @($androidJar, $aapt2, $zipalign, $d8Jar, $signerJar, $lambdaStubs)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Android SDK tool missing: $requiredFile. Run this script with -InstallToolchain, or supply -SdkRoot for an SDK containing build-tools 30.0.3 and platform android-30. SDK files must be outside this repository."
    }
}

if (-not $JdkRoot) {
    $javacCommand = Get-Command javac.exe -ErrorAction SilentlyContinue
    if ($javacCommand) { $JdkRoot = Split-Path -Parent (Split-Path -Parent $javacCommand.Source) }
}
$jdkTools = @{}
foreach ($toolName in @('java', 'javac', 'jar', 'keytool')) {
    if (-not $JdkRoot) { throw 'Install a JDK 8 or 17 outside the repository and pass -JdkRoot, or set JAVA_HOME.' }
    $jdkTools[$toolName] = Join-Path $JdkRoot ('bin\' + $toolName + '.exe')
    if (-not (Test-Path -LiteralPath $jdkTools[$toolName] -PathType Leaf)) {
        throw "JDK tool missing: $($jdkTools[$toolName]). Pass -JdkRoot for a complete JDK 8 or 17."
    }
}

# A new directory per build avoids stale bytecode and keeps generated content out of Git.
$workDirectory = Join-Path $BuildRoot ([Guid]::NewGuid().ToString('N'))
$generatedSources = Join-Path $workDirectory 'generated'
$classesDirectory = Join-Path $workDirectory 'classes'
$dexDirectory = Join-Path $workDirectory 'dex'
New-Item -ItemType Directory -Path $generatedSources, $classesDirectory, $dexDirectory -Force | Out-Null
$compiledResources = Join-Path $workDirectory 'resources.zip'
$unsignedApk = Join-Path $workDirectory 'unsigned.apk'
$alignedApk = Join-Path $workDirectory 'aligned.apk'
$signedApk = Join-Path $workDirectory 'signed.apk'
$classesJar = Join-Path $workDirectory 'classes.jar'
$sourceRoot = Join-Path $projectRoot 'android\src'

# AAPT2 30 cannot enumerate a non-ASCII absolute resource-directory name on Windows.
# Use a relative staged input; staging remains outside the source checkout.
Copy-Item -LiteralPath (Join-Path $projectRoot 'android\res') -Destination (Join-Path $workDirectory 'resource-input') -Recurse
Push-Location -LiteralPath $workDirectory
try {
    Invoke-BuildTool $aapt2 @('compile', '--dir', 'resource-input', '-o', $compiledResources)
} finally {
    Pop-Location
}
Invoke-BuildTool $aapt2 @('link', '-o', $unsignedApk, '-I', $androidJar, '--manifest',
    (Join-Path $projectRoot 'android\AndroidManifest.xml'), '--java', $generatedSources, $compiledResources)
$sourceFiles = @(Get-ChildItem -LiteralPath $sourceRoot, $generatedSources -Recurse -Filter '*.java' -File)
if (-not ($sourceFiles | Where-Object { $_.FullName.StartsWith($sourceRoot, [StringComparison]::OrdinalIgnoreCase) })) {
    throw "No Android Java sources found in $sourceRoot"
}
$sourceArguments = Join-Path $workDirectory 'java-sources.txt'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllLines($sourceArguments, [string[]]($sourceFiles | ForEach-Object {
    '"' + $_.FullName.Replace('\', '/') + '"'
}), $utf8)
Invoke-BuildTool $jdkTools['javac'] @('-J-Dfile.encoding=UTF-8', '-encoding', 'UTF-8', '-source', '8', '-target', '8',
    '-bootclasspath', ($lambdaStubs + [IO.Path]::PathSeparator + $androidJar), '-d', $classesDirectory, ('@' + $sourceArguments))
Invoke-BuildTool $jdkTools['jar'] @('cf', $classesJar, '-C', $classesDirectory, '.')
Invoke-BuildTool $jdkTools['java'] @('-cp', $d8Jar, 'com.android.tools.r8.D8', '--min-api', '26',
    '--lib', $androidJar, '--output', $dexDirectory, $classesJar)
$dexFiles = @(Get-ChildItem -LiteralPath $dexDirectory -Filter '*.dex' -File)
if ($dexFiles.Count -eq 0) { throw 'D8 did not generate any DEX files.' }
foreach ($dexFile in $dexFiles) {
    Invoke-BuildTool $jdkTools['jar'] @('uf', $unsignedApk, '-C', $dexDirectory, $dexFile.Name)
}
Invoke-BuildTool $zipalign @('-f', '4', $unsignedApk, $alignedApk)

$usingLocalTestKey = [string]::IsNullOrWhiteSpace($KeyStore)
if ($usingLocalTestKey) {
    $signingDirectory = Join-Path $env:LOCALAPPDATA 'WarehousePda\signing'
    $KeyStore = Join-Path $signingDirectory 'warehouse-pda-test.jks'
    $KeyAlias = 'warehouse-pda-test'
    New-Item -ItemType Directory -Path $signingDirectory -Force | Out-Null
} else {
    if (-not $env:PDA_KEYSTORE_PASSWORD) { throw 'Set PDA_KEYSTORE_PASSWORD for the supplied KeyStore.' }
    if (-not (Test-Path -LiteralPath $KeyStore -PathType Leaf)) { throw "KeyStore not found: $KeyStore" }
}
$KeyStore = Assert-ExternalPath $KeyStore 'Signing key'
$previousStorePassword = $env:PDA_BUILD_STORE_PASSWORD
$previousKeyPassword = $env:PDA_BUILD_KEY_PASSWORD
try {
    # The standard public "android" password is only for the local installation/test key.
    # For production, supply an externally managed KeyStore and passwords via environment variables.
    if ($usingLocalTestKey) {
        $env:PDA_BUILD_STORE_PASSWORD = 'android'
        $env:PDA_BUILD_KEY_PASSWORD = 'android'
    } else {
        $env:PDA_BUILD_STORE_PASSWORD = $env:PDA_KEYSTORE_PASSWORD
        $env:PDA_BUILD_KEY_PASSWORD = if ($env:PDA_KEY_PASSWORD) { $env:PDA_KEY_PASSWORD } else { $env:PDA_KEYSTORE_PASSWORD }
    }
    if ($usingLocalTestKey -and -not (Test-Path -LiteralPath $KeyStore -PathType Leaf)) {
        Invoke-BuildTool $jdkTools['keytool'] @('-genkeypair', '-keystore', $KeyStore, '-storetype', 'JKS',
            '-storepass:env', 'PDA_BUILD_STORE_PASSWORD', '-keypass:env', 'PDA_BUILD_KEY_PASSWORD',
            '-alias', $KeyAlias, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
            '-dname', 'CN=Warehouse PDA Local Test, O=Local Development, C=CN', '-noprompt')
    }
    Invoke-BuildTool $jdkTools['java'] @('-jar', $signerJar, 'sign', '--ks', $KeyStore,
        '--ks-key-alias', $KeyAlias, '--ks-pass', 'env:PDA_BUILD_STORE_PASSWORD',
        '--key-pass', 'env:PDA_BUILD_KEY_PASSWORD', '--out', $signedApk, $alignedApk)
    Invoke-BuildTool $jdkTools['java'] @('-jar', $signerJar, 'verify', '--verbose', $signedApk)
    Invoke-BuildTool $zipalign @('-c', '4', $signedApk)
} finally {
    $env:PDA_BUILD_STORE_PASSWORD = $previousStorePassword
    $env:PDA_BUILD_KEY_PASSWORD = $previousKeyPassword
}

$releaseDirectory = Join-Path $projectRoot 'release'
New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
$deliverable = Join-Path $releaseDirectory '仓库PDA扫码.apk'
Copy-Item -LiteralPath $signedApk -Destination $deliverable -Force
Write-Host "Built and verified: $deliverable"
Write-Host "Build intermediates: $workDirectory"
if ($usingLocalTestKey) {
    Write-Host "Local test signing key: $KeyStore"
    Write-Host 'Retain this key for in-place updates. Use a protected production key before managed distribution.'
}
