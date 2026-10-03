// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SuperbankVKYC",
    platforms: [
        .iOS(.v15),
    ],
    products: [
        .library(name: "SuperbankVKYC", targets: ["SuperbankVKYC"]),
    ],
    targets: [
        .target(name: "SuperbankVKYC"),
    ]
)
