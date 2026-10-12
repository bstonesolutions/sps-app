import UIKit
import Capacitor

// UIKit owns the window through this scene, including on iOS 27. Main.storyboard
// still creates MainViewController so the existing Capacitor plugins are registered.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard scene is UIWindowScene else { return }
        // Capacitor 8.4's splash plugin also checks the app delegate's window.
        (UIApplication.shared.delegate as? AppDelegate)?.window = window

        // Scene-based apps receive launch links here instead of in AppDelegate.
        // The proxy retains lastURL for JavaScript's App.getLaunchUrl() call.
        for context in connectionOptions.urlContexts {
            open(context)
        }
        for activity in connectionOptions.userActivities {
            continueActivity(activity)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            open(context)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        continueActivity(userActivity)
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        let appDelegate = UIApplication.shared.delegate as? AppDelegate
        if appDelegate?.window === window {
            appDelegate?.window = nil
        }
    }

    private func open(_ context: UIOpenURLContext) {
        var options: [UIApplication.OpenURLOptionsKey: Any] = [
            .openInPlace: context.options.openInPlace
        ]
        if let source = context.options.sourceApplication {
            options[.sourceApplication] = source
        }
        if let annotation = context.options.annotation {
            options[.annotation] = annotation
        }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: options)
    }

    private func continueActivity(_ activity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
}
