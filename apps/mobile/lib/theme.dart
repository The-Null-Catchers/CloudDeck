import 'package:flutter/material.dart';
const _seed=Color(0xff4f6bed);
ThemeData _theme(Brightness brightness){
  final scheme=ColorScheme.fromSeed(seedColor:_seed,brightness:brightness);
  return ThemeData(
    useMaterial3:true,brightness:brightness,colorScheme:scheme,
    scaffoldBackgroundColor:brightness==Brightness.dark?const Color(0xff10131a):const Color(0xfff6f7fb),
    cardTheme:CardThemeData(elevation:0,margin:EdgeInsets.zero,shape:RoundedRectangleBorder(borderRadius:BorderRadius.circular(18)),color:brightness==Brightness.dark?const Color(0xff171b24):Colors.white),
    navigationBarTheme:NavigationBarThemeData(height:72,indicatorShape:RoundedRectangleBorder(borderRadius:BorderRadius.circular(14))),
    inputDecorationTheme:InputDecorationTheme(filled:true,border:OutlineInputBorder(borderRadius:BorderRadius.circular(14),borderSide:BorderSide.none),enabledBorder:OutlineInputBorder(borderRadius:BorderRadius.circular(14),borderSide:BorderSide.none),focusedBorder:OutlineInputBorder(borderRadius:BorderRadius.circular(14),borderSide:BorderSide(color:scheme.primary,width:1.4))),
    filledButtonTheme:FilledButtonThemeData(style:FilledButton.styleFrom(minimumSize:const Size.fromHeight(52),shape:RoundedRectangleBorder(borderRadius:BorderRadius.circular(14)))),
  );
}
final cloudDeckLightTheme=_theme(Brightness.light);
final cloudDeckDarkTheme=_theme(Brightness.dark);
