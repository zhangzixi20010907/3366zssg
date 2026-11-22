package game.ui
{
   import flash.display.DisplayObject;
   import flash.display.MovieClip;
   import flash.events.Event;

   /**
    * 第 10 个入口：符号内叠了 9 个大地图建筑按钮的图形（_art0.._art8），
    * 进入舞台后随机显示其中一个。
    */
   public class Wulin10Button extends MovieClip
   {
      public function Wulin10Button()
      {
         super();
         addEventListener(Event.ENTER_FRAME,this.onFirstFrame);
      }

      private function onFirstFrame(e:Event) : void
      {
         removeEventListener(Event.ENTER_FRAME,this.onFirstFrame);
         var pick:int = int(Math.random() * 9);
         var i:int = 0;
         while(i < numChildren)
         {
            var c:DisplayObject = getChildAt(i);
            if(c != null && c.name != null && c.name.indexOf("_art") == 0)
            {
               c.visible = c.name == "_art" + pick;
            }
            i++;
         }
      }
   }
}
