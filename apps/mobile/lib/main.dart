import 'package:flutter/material.dart';
import 'app_state.dart';
import 'core/api_client.dart';
import 'core/session_store.dart';
import 'screens/login_screen.dart';
import 'screens/shell_screen.dart';
import 'theme.dart';

void main(){
  WidgetsFlutterBinding.ensureInitialized();
  final state=AppState(ApiClient(sessionStore:SecureSessionStore()));
  runApp(CloudDeckApp(state:state));
  state.bootstrap();
}

final class CloudDeckApp extends StatelessWidget {
  const CloudDeckApp({super.key,required this.state});
  final AppState state;
  @override
  Widget build(BuildContext context)=>MaterialApp(
    title:'CloudDeck',debugShowCheckedModeBanner:false,
    theme:cloudDeckLightTheme,darkTheme:cloudDeckDarkTheme,themeMode:ThemeMode.system,
    home:AnimatedBuilder(animation:state,builder:(context,_)=>switch(state.sessionStatus){
      SessionStatus.booting=>const Scaffold(body:Center(child:CircularProgressIndicator())),
      SessionStatus.signedOut=>LoginScreen(state:state),
      SessionStatus.signedIn=>ShellScreen(state:state),
    }),
  );
}
