package tech.agantay.fitness;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StepCounterPlugin.class);   // local plugins, must be registered before super.onCreate
        registerPlugin(WorkoutRecorderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
